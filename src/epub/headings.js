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

function getStyledTitleCandidates(doc, styledClasses) {
  const selector = "b, strong, font[size], [class], [style]"
  const candidates = Array.from(doc.querySelectorAll(selector))
  const blocks = []
  const seenBlocks = new WeakSet()

  for (const element of candidates) {
    const title = normalizeWhitespace(element.textContent)
    if (!title || title.length > 160) {
      continue
    }

    const classNames = String(element.getAttribute("class") || "")
    const classTokens = classNames.split(/\s+/)
    const style = String(element.getAttribute("style") || "")
    const hasTitleStyle =
      ["b", "strong"].includes(String(element.localName).toLowerCase()) ||
      (String(element.localName).toLowerCase() === "font" && element.hasAttribute("size")) ||
      /\b(bold|heading|title|chapter)\b/i.test(classNames) ||
      classTokens.some((name) => styledClasses.has(name)) ||
      /font-weight\s*:\s*(bold|[6-9]00)/i.test(style) ||
      /font-size\s*:\s*(?:larger|large|x-large|xx-large|(?:1\.[1-9]\d*|[2-9]\d*)\s*(?:em|rem)|(?:1[2-9]\d|[2-9]\d{2,})\s*%)/i.test(style)
    if (!hasTitleStyle) {
      continue
    }

    let block = element
    while (block && !["p", "div", "section", "article", "li", "td"].includes(
      String(block.localName || "").toLowerCase(),
    )) {
      block = block.parentElement
    }

    if (
      block &&
      normalizeWhitespace(block.textContent) === title &&
      !seenBlocks.has(block) &&
      !Array.from(element.querySelectorAll("b, strong, [class~='bold']"))
        .some((child) => normalizeWhitespace(child.textContent) === title)
    ) {
      seenBlocks.add(block)
      blocks.push({ element, block, title })
    }
  }

  return blocks
}

async function getStyledClasses(epubData) {
  const styledClasses = new Set()
  const stylesheetItems = Array.from(epubData.manifest.values()).filter(
    (item) => String(item.mediaType || "").toLowerCase() === "text/css",
  )

  for (const item of stylesheetItems) {
    const css = await getFileContent(epubData, item.fullPath)
    for (const match of css.matchAll(/\.([a-zA-Z_][\w-]*)[^{}]*\{([^{}]*)\}/g)) {
      const declarations = match[2]
      if (
        /font-weight\s*:\s*(bold|[6-9]00)/i.test(declarations) ||
        /font-size\s*:\s*(?:larger|large|x-large|xx-large|(?:1\.[1-9]\d*|[2-9]\d*)\s*(?:em|rem)|(?:1[2-9]\d|[2-9]\d{2,})\s*%)/i.test(declarations)
      ) {
        styledClasses.add(match[1])
      }
    }
  }

  return styledClasses
}

export async function extractStyledTitleMarkers(epubData) {
  const chapterFiles = getChapterFiles(epubData)
  const chapters = []
  const styledClasses = await getStyledClasses(epubData)

  for (let chapterIndex = 0; chapterIndex < chapterFiles.length; chapterIndex += 1) {
    const chapter = chapterFiles[chapterIndex]
    const content = await getFileContent(epubData, chapter.fullPath)
    const doc = parseChapterDocument(content)
    const headings = []
    const seenIds = new Set()

    for (const candidate of getStyledTitleCandidates(doc, styledClasses)) {
      const target = candidate.block.hasAttribute("id")
        ? candidate.block
        : candidate.element
      const id = ensureHeadingId(target)
      if (seenIds.has(id)) {
        continue
      }
      seenIds.add(id)

      headings.push({
        id: `styled-${chapterIndex}-${headings.length + 1}`,
        targetId: id,
        level: 1,
        title: candidate.title,
        page: "",
        source: "styled",
        chapterIndex,
        chapterHref: chapter.href,
        chapterFullPath: chapter.fullPath,
        href: `${chapter.href}#${id}`,
      })
    }

    if (headings.length > 0) {
      setFileContent(epubData, chapter.fullPath, serializeDocument(doc))
    }

    chapters.push({
      chapterIndex,
      chapterHref: chapter.href,
      chapterFullPath: chapter.fullPath,
      headings,
    })
  }

  return chapters
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

const WORDS_PER_PAGE = 250

function countWordsInRange(doc, startNode, endNode) {
  const body = doc.querySelector("body") || doc.documentElement
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */)
  let counting = startNode ? false : true
  let words = 0

  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node === startNode || node.parentNode === startNode) {
      counting = true
    }
    if (endNode && (node === endNode || node.parentNode === endNode)) {
      break
    }
    if (counting) {
      const text = node.textContent.trim()
      if (text) {
        words += text.split(/\s+/).length
      }
    }
  }

  return words
}

function countWordsBeforeNode(doc, targetNode) {
  const body = doc.querySelector("body") || doc.documentElement
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */)
  let words = 0

  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node === targetNode || node.parentNode === targetNode) {
      break
    }
    const text = node.textContent.trim()
    if (text) {
      words += text.split(/\s+/).length
    }
  }

  return words
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export async function extractHeadings(epubData) {
  const chapterFiles = getChapterFiles(epubData)
  const chapters = []
  let cumulativeWords = 0

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
      const wordsBefore = countWordsBeforeNode(doc, el)
      const page = Math.max(1, Math.ceil((cumulativeWords + wordsBefore) / WORDS_PER_PAGE))

      headings.push({ level, title, id, page, source: "html" })
    }

    // Count total words in this chapter file for cumulative tracking
    const body = doc.querySelector("body") || doc.documentElement
    const allText = body.textContent || ""
    const chapterWords = allText.trim() ? allText.trim().split(/\s+/).length : 0
    cumulativeWords += chapterWords

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

export function renameChapterMarker(epubData, markerId, newTitle) {
  const marker = epubData.chapterMarkers?.find((item) => item.id === markerId)
  if (!marker) {
    throw new Error(`Chapter marker "${markerId}" not found`)
  }
  marker.title = newTitle
}

export function deleteChapterMarker(epubData, markerId) {
  const markers = epubData.chapterMarkers || []
  const index = markers.findIndex((item) => item.id === markerId)
  if (index < 0) {
    throw new Error(`Chapter marker "${markerId}" not found`)
  }
  markers.splice(index, 1)
}

export function changeChapterMarkerLevel(epubData, markerId, newLevel) {
  if (!Number.isInteger(newLevel) || newLevel < 1 || newLevel > 3) {
    throw new Error(`Invalid heading level: ${newLevel}`)
  }
  const marker = epubData.chapterMarkers?.find((item) => item.id === markerId)
  if (!marker) {
    throw new Error(`Chapter marker "${markerId}" not found`)
  }
  marker.level = newLevel
}

export function changeChapterMarkerLevels(epubData, updates) {
  for (const update of updates) {
    changeChapterMarkerLevel(epubData, update.headingId, update.newLevel)
  }
}

export function reorderChapterMarkers(epubData, chapterFullPath, newOrder) {
  const markers = epubData.chapterMarkers || []
  const chapterMarkers = markers.filter((marker) => marker.chapterFullPath === chapterFullPath)
  const markerById = new Map(chapterMarkers.map((marker) => [marker.id, marker]))
  const reordered = newOrder.map((id) => markerById.get(id)).filter(Boolean)

  for (const marker of chapterMarkers) {
    if (!newOrder.includes(marker.id)) {
      reordered.push(marker)
    }
  }

  let nextIndex = 0
  for (let index = 0; index < markers.length; index += 1) {
    if (markers[index].chapterFullPath === chapterFullPath) {
      markers[index] = reordered[nextIndex]
      nextIndex += 1
    }
  }
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

function changeHeadingLevelInDoc(doc, headingId, newLevel) {
  if (newLevel < 1 || newLevel > 3) {
    throw new Error(`Invalid heading level: ${newLevel}`)
  }

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
}

export async function changeHeadingLevel(epubData, chapterFullPath, headingId, newLevel) {
  const doc = await loadAndParse(epubData, chapterFullPath)
  changeHeadingLevelInDoc(doc, headingId, newLevel)
  saveDocument(epubData, chapterFullPath, doc)
}

/**
 * Change the level of many headings at once.
 * `updates` is an array of { chapterFullPath, headingId, newLevel }.
 * Headings are grouped by chapter so each chapter document is parsed and
 * serialized only once.
 */
export async function changeHeadingLevels(epubData, updates) {
  const byChapter = new Map()
  for (const update of updates) {
    if (!byChapter.has(update.chapterFullPath)) {
      byChapter.set(update.chapterFullPath, [])
    }
    byChapter.get(update.chapterFullPath).push(update)
  }

  for (const [chapterFullPath, chapterUpdates] of byChapter) {
    const doc = await loadAndParse(epubData, chapterFullPath)
    for (const { headingId, newLevel } of chapterUpdates) {
      changeHeadingLevelInDoc(doc, headingId, newLevel)
    }
    saveDocument(epubData, chapterFullPath, doc)
  }
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
