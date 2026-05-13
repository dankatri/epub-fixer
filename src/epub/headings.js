import { getChapterFiles, getFileContent, setFileContent } from "./reader.js"

const HEADING_TAGS = ["h1", "h2", "h3"]
const HEADING_SELECTOR = HEADING_TAGS.join(", ")

let nextTempId = 1

export function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

function hasParserError(doc) {
  if (!doc) {
    return false
  }

  if (typeof doc.querySelector === "function" && doc.querySelector("parsererror")) {
    return true
  }

  return Boolean(
    doc.getElementsByTagName("parsererror")[0] ||
    doc.getElementsByTagNameNS("*", "parsererror")[0],
  )
}

export function parseChapterDocument(content) {
  if (typeof DOMParser === "undefined") {
    throw new Error("DOMParser is not available in this environment")
  }

  const parser = new DOMParser()
  const xhtmlDoc = parser.parseFromString(String(content || ""), "application/xhtml+xml")

  if (!hasParserError(xhtmlDoc)) {
    return xhtmlDoc
  }

  return parser.parseFromString(String(content || ""), "text/html")
}

function parseChapterDocumentStrict(content) {
  if (typeof DOMParser === "undefined") {
    throw new Error("DOMParser is not available in this environment")
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(String(content || ""), "application/xhtml+xml")

  if (hasParserError(doc)) {
    throw new Error("Invalid XHTML — run validation first")
  }

  return doc
}

export function collectHeadingElements(doc) {
  if (typeof doc.querySelectorAll === "function") {
    return Array.from(doc.querySelectorAll(HEADING_SELECTOR))
  }

  const result = []
  for (const tag of HEADING_TAGS) {
    result.push(...Array.from(doc.getElementsByTagName(tag)))
  }
  return result
}

function getHeadingLevel(element) {
  const tagName = String(element.localName || element.nodeName || "").toLowerCase()
  return Number(tagName.slice(1))
}

function ensureHeadingId(element) {
  let id = String(element.getAttribute("id") || "").trim()
  if (!id) {
    id = `_epubfixer_h${nextTempId}`
    nextTempId += 1
    element.setAttribute("id", id)
  }
  return id
}

function serializeDocument(doc) {
  const serializer = new XMLSerializer()
  let xml = serializer.serializeToString(doc)

  if (!xml.startsWith("<?xml")) {
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml
  }

  return xml
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export async function extractHeadings(epubData) {
  const chapterFiles = getChapterFiles(epubData)
  const chapters = []

  for (let i = 0; i < chapterFiles.length; i++) {
    const chapter = chapterFiles[i]
    const content = await getFileContent(epubData, chapter.fullPath)
    const doc = parseChapterDocument(content)
    const headingElements = collectHeadingElements(doc)
    const headings = []

    for (const el of headingElements) {
      const level = getHeadingLevel(el)
      if (level < 1 || level > 3) {
        continue
      }

      const title = normalizeWhitespace(el.textContent)
      if (!title) {
        continue
      }

      const id = ensureHeadingId(el)

      headings.push({ level, title, id })
    }

    // Write back the doc if we added any temp IDs
    const updatedContent = serializeDocument(doc)
    setFileContent(epubData, chapter.fullPath, updatedContent)

    chapters.push({
      chapterIndex: i,
      chapterHref: chapter.href,
      chapterFullPath: chapter.fullPath,
      headings,
    })
  }

  return chapters
}

// ---------------------------------------------------------------------------
// Mutations — all operate on a single chapter's XHTML
// ---------------------------------------------------------------------------

async function loadAndParse(epubData, chapterFullPath) {
  const content = await getFileContent(epubData, chapterFullPath)
  return parseChapterDocumentStrict(content)
}

function findHeadingById(doc, headingId) {
  const el = doc.getElementById(headingId)
  if (!el) {
    throw new Error(`Heading with id "${headingId}" not found`)
  }

  const level = getHeadingLevel(el)
  if (level < 1 || level > 3) {
    throw new Error(`Element with id "${headingId}" is not a heading`)
  }

  return el
}

function saveDocument(epubData, chapterFullPath, doc) {
  setFileContent(epubData, chapterFullPath, serializeDocument(doc))
}

export async function renameHeading(epubData, chapterFullPath, headingId, newTitle) {
  const doc = await loadAndParse(epubData, chapterFullPath)
  const el = findHeadingById(doc, headingId)
  el.textContent = newTitle
  saveDocument(epubData, chapterFullPath, doc)
}

export async function deleteHeading(epubData, chapterFullPath, headingId) {
  const doc = await loadAndParse(epubData, chapterFullPath)
  const el = findHeadingById(doc, headingId)
  el.parentNode.removeChild(el)
  saveDocument(epubData, chapterFullPath, doc)
}

export async function changeHeadingLevel(epubData, chapterFullPath, headingId, newLevel) {
  if (newLevel < 1 || newLevel > 3) {
    throw new Error(`Invalid heading level: ${newLevel}`)
  }

  const doc = await loadAndParse(epubData, chapterFullPath)
  const oldEl = findHeadingById(doc, headingId)

  const ns = oldEl.namespaceURI
  const newTag = `h${newLevel}`
  const newEl = ns
    ? doc.createElementNS(ns, newTag)
    : doc.createElement(newTag)

  // Copy attributes
  for (const attr of Array.from(oldEl.attributes)) {
    newEl.setAttribute(attr.name, attr.value)
  }

  // Move children
  while (oldEl.firstChild) {
    newEl.appendChild(oldEl.firstChild)
  }

  oldEl.parentNode.replaceChild(newEl, oldEl)
  saveDocument(epubData, chapterFullPath, doc)
}

/**
 * Reorder heading sections within a chapter.
 * Each "section" is a heading plus all siblings until the next heading of same or higher level.
 * `newOrder` is an array of heading IDs in the desired order.
 */
export async function reorderHeadings(epubData, chapterFullPath, newOrder) {
  const doc = await loadAndParse(epubData, chapterFullPath)
  const headingElements = collectHeadingElements(doc)

  if (headingElements.length < 2) {
    return
  }

  // Build sections: each section is [heading, ...following siblings until next heading]
  const sections = []
  for (let i = 0; i < headingElements.length; i++) {
    const heading = headingElements[i]
    const sectionNodes = [heading]
    let sibling = heading.nextSibling

    const nextHeading = headingElements[i + 1] || null

    while (sibling && sibling !== nextHeading) {
      sectionNodes.push(sibling)
      sibling = sibling.nextSibling
    }

    const id = String(heading.getAttribute("id") || "").trim()
    sections.push({ id, nodes: sectionNodes })
  }

  // Build a map of id -> section
  const sectionMap = new Map()
  for (const section of sections) {
    if (section.id) {
      sectionMap.set(section.id, section)
    }
  }

  // Determine the parent and the insertion point (node before the first heading)
  const parent = headingElements[0].parentNode
  const firstHeading = headingElements[0]
  const insertBefore = firstHeading

  // Collect all nodes that belong to any section
  const allSectionNodes = new Set()
  for (const section of sections) {
    for (const node of section.nodes) {
      allSectionNodes.add(node)
    }
  }

  // Remove all section nodes
  for (const node of allSectionNodes) {
    if (node.parentNode) {
      node.parentNode.removeChild(node)
    }
  }

  // Re-insert in new order
  const referenceNode = insertBefore.parentNode ? null : null
  for (const id of newOrder) {
    const section = sectionMap.get(id)
    if (!section) {
      continue
    }

    for (const node of section.nodes) {
      parent.appendChild(node)
    }
  }

  // Append any sections not in newOrder (preserve them at the end)
  for (const section of sections) {
    if (!newOrder.includes(section.id)) {
      for (const node of section.nodes) {
        parent.appendChild(node)
      }
    }
  }

  saveDocument(epubData, chapterFullPath, doc)
}
