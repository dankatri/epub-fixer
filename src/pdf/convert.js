import JSZip from "jszip"
import * as pdfjsLib from "pdfjs-dist"
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function sanitizeTitle(value) {
  return String(value || "")
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .trim()
}

function generateUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === "x" ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

// Group a page's text items into lines based on their vertical position, then
// classify each line's dominant font size so headings can be detected later.
function buildLines(textContent) {
  const lines = []
  let current = null

  for (const item of textContent.items) {
    const text = item.str
    if (typeof text !== "string") {
      continue
    }

    const transform = item.transform || [1, 0, 0, 1, 0, 0]
    const y = transform[5]
    const size = Math.abs(item.height) || Math.hypot(transform[2], transform[3]) || 12

    if (!current || Math.abs(current.y - y) > Math.max(2, size * 0.6)) {
      if (current) {
        lines.push(current)
      }
      current = { y, text: "", size, sizeWeight: 0 }
    }

    current.text += text
    if (text.trim()) {
      current.size = (current.size * current.sizeWeight + size * text.length) /
        (current.sizeWeight + text.length)
      current.sizeWeight += text.length
    }

    if (item.hasEOL) {
      lines.push(current)
      current = null
    }
  }

  if (current) {
    lines.push(current)
  }

  return lines
    .map((line) => ({ text: line.text.replace(/\s+/g, " ").trim(), size: line.size, y: line.y }))
    .filter((line) => line.text.length > 0)
}

function computeBodySize(allLines) {
  const counts = new Map()
  for (const line of allLines) {
    const rounded = Math.round(line.size)
    const weight = line.text.length
    counts.set(rounded, (counts.get(rounded) || 0) + weight)
  }

  let bodySize = 12
  let best = -1
  for (const [size, weight] of counts) {
    if (weight > best) {
      best = weight
      bodySize = size
    }
  }
  return bodySize
}

function classifyLine(line, bodySize) {
  const wordCount = line.text.split(/\s+/).length
  if (line.size >= bodySize * 1.5 && wordCount <= 16) {
    return { type: "heading", level: 1 }
  }
  if (line.size >= bodySize * 1.2 && wordCount <= 16) {
    return { type: "heading", level: 2 }
  }
  return { type: "para" }
}

// Turn the flat list of classified lines into chapters. A new chapter begins at
// every level-1 heading; paragraphs accumulate until the next heading.
function buildChapters(pages, bodySize, fallbackTitle) {
  const chapters = []
  let chapter = null
  let paragraph = ""

  const flushParagraph = () => {
    const text = paragraph.replace(/\s+/g, " ").trim()
    if (text && chapter) {
      chapter.blocks.push({ type: "para", text })
    }
    paragraph = ""
  }

  const startChapter = (title) => {
    flushParagraph()
    chapter = { title, blocks: [] }
    chapters.push(chapter)
  }

  for (const lines of pages) {
    for (const line of lines) {
      const info = classifyLine(line, bodySize)

      if (info.type === "heading" && info.level === 1) {
        startChapter(line.text)
        chapter.blocks.push({ type: "heading", level: 1, text: line.text })
        continue
      }

      if (!chapter) {
        startChapter(fallbackTitle)
      }

      if (info.type === "heading") {
        flushParagraph()
        chapter.blocks.push({ type: "heading", level: info.level, text: line.text })
        continue
      }

      // Join hyphenated line breaks; otherwise separate lines with a space.
      if (/[-\u2010]$/.test(paragraph)) {
        paragraph = paragraph.replace(/[-\u2010]$/, "") + line.text
      } else if (paragraph) {
        paragraph += " " + line.text
      } else {
        paragraph = line.text
      }

      // A short line that ends with sentence punctuation likely ends a paragraph.
      if (/[.!?\u2026]["'\u201d\u2019)]?$/.test(line.text) && line.text.length < bodySize * 4) {
        flushParagraph()
      }
    }
    flushParagraph()
  }

  flushParagraph()

  if (chapters.length === 0) {
    chapters.push({ title: fallbackTitle, blocks: [] })
  }

  return chapters
}

function renderChapterXhtml(chapter, index) {
  const heading = chapter.blocks.some((block) => block.type === "heading")
  const body = []

  if (!heading) {
    body.push(`    <h1>${escapeXml(chapter.title || `Chapter ${index + 1}`)}</h1>`)
  }

  for (const block of chapter.blocks) {
    if (block.type === "heading") {
      const level = Math.min(Math.max(block.level || 1, 1), 6)
      body.push(`    <h${level}>${escapeXml(block.text)}</h${level}>`)
    } else {
      body.push(`    <p>${escapeXml(block.text)}</p>`)
    }
  }

  if (chapter.blocks.length === 0) {
    body.push("    <p></p>")
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">',
    "  <head>",
    `    <title>${escapeXml(chapter.title || `Chapter ${index + 1}`)}</title>`,
    "    <meta charset=\"utf-8\" />",
    "  </head>",
    "  <body>",
    ...body,
    "  </body>",
    "</html>",
  ].join("\n")
}

function buildOpf(chapters, meta) {
  const manifestItems = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
  ]
  const spineItems = []

  chapters.forEach((_, index) => {
    const id = `chapter-${index + 1}`
    manifestItems.push(
      `    <item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    spineItems.push(`    <itemref idref="${id}"/>`)
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="book-id">urn:uuid:${escapeXml(meta.uuid)}</dc:identifier>`,
    `    <dc:title>${escapeXml(meta.title)}</dc:title>`,
    `    <dc:language>${escapeXml(meta.language || "en")}</dc:language>`,
    `    <dc:creator>${escapeXml(meta.author || "Unknown")}</dc:creator>`,
    `    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>`,
    "  </metadata>",
    "  <manifest>",
    ...manifestItems,
    "  </manifest>",
    "  <spine toc=\"ncx\">",
    ...spineItems,
    "  </spine>",
    "</package>",
  ].join("\n")
}

function buildNav(chapters, title) {
  const items = chapters.map((chapter, index) => {
    const label = chapter.title || `Chapter ${index + 1}`
    return `        <li><a href="chapter-${index + 1}.xhtml">${escapeXml(label)}</a></li>`
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">',
    "  <head>",
    `    <title>${escapeXml(title)}</title>`,
    "    <meta charset=\"utf-8\" />",
    "  </head>",
    "  <body>",
    '    <nav epub:type="toc" id="toc">',
    `      <h1>${escapeXml(title)}</h1>`,
    "      <ol>",
    ...items,
    "      </ol>",
    "    </nav>",
    "  </body>",
    "</html>",
  ].join("\n")
}

function buildNcx(chapters, meta) {
  const navPoints = chapters.map((chapter, index) => {
    const label = chapter.title || `Chapter ${index + 1}`
    return [
      `    <navPoint id="navpoint-${index + 1}" playOrder="${index + 1}">`,
      `      <navLabel><text>${escapeXml(label)}</text></navLabel>`,
      `      <content src="chapter-${index + 1}.xhtml"/>`,
      "    </navPoint>",
    ].join("\n")
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
    "  <head>",
    `    <meta name="dtb:uid" content="urn:uuid:${escapeXml(meta.uuid)}"/>`,
    "  </head>",
    `  <docTitle><text>${escapeXml(meta.title)}</text></docTitle>`,
    "  <navMap>",
    ...navPoints,
    "  </navMap>",
    "</ncx>",
  ].join("\n")
}

/**
 * Convert a PDF file/blob into an EPUB Blob entirely in the browser.
 *
 * @param {File|Blob} file The source PDF.
 * @param {(message: string) => void} [onProgress] Optional progress logger.
 * @returns {Promise<Blob>} An `application/epub+zip` blob ready for readEpub.
 */
export async function convertPdfToEpub(file, onProgress = () => {}) {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise

  onProgress(`PDF loaded: ${pdf.numPages} page(s)`)

  const pages = []
  const allLines = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const lines = buildLines(textContent)
    pages.push(lines)
    allLines.push(...lines)
    page.cleanup()
    if (pageNumber % 25 === 0 || pageNumber === pdf.numPages) {
      onProgress(`Extracted text from ${pageNumber}/${pdf.numPages} pages`)
    }
  }

  const info = await pdf.getMetadata().catch(() => null)
  const pdfTitle = sanitizeTitle(info?.info?.Title)
  const pdfAuthor = info?.info?.Author ? String(info.info.Author).trim() : ""
  const fallbackTitle = pdfTitle || sanitizeTitle(file.name) || "Untitled"

  const bodySize = computeBodySize(allLines)
  const chapters = buildChapters(pages, bodySize, fallbackTitle)
  onProgress(`Built ${chapters.length} chapter(s) from PDF content`)

  const meta = {
    uuid: generateUuid(),
    title: pdfTitle || fallbackTitle,
    author: pdfAuthor,
    language: "en",
  }

  const zip = new JSZip()
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" })
  zip.file(
    "META-INF/container.xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
      "  <rootfiles>",
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
      "  </rootfiles>",
      "</container>",
    ].join("\n"),
  )

  zip.file("OEBPS/content.opf", buildOpf(chapters, meta))
  zip.file("OEBPS/nav.xhtml", buildNav(chapters, meta.title))
  zip.file("OEBPS/toc.ncx", buildNcx(chapters, meta))

  chapters.forEach((chapter, index) => {
    zip.file(`OEBPS/chapter-${index + 1}.xhtml`, renderChapterXhtml(chapter, index))
  })

  await pdf.destroy()

  return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" })
}
