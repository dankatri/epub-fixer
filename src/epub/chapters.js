import { getChapterFiles, getFileContent, setFileContent } from "./reader.js"

const OPF_NS = "http://www.idpf.org/2007/opf"
const XHTML_NS = "http://www.w3.org/1999/xhtml"
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'

const VOID_TAGS = ["br", "hr", "img", "link", "meta", "input"]

function getErrorMessage(error) {
  if (error && typeof error.message === "string" && error.message) {
    return error.message
  }

  return String(error)
}

function normalizeZipPath(inputPath) {
  const path = String(inputPath || "").replace(/\\/g, "/").replace(/^\/+/, "")
  const segments = path.split("/")
  const normalized = []

  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue
    }

    if (segment === "..") {
      if (normalized.length > 0) {
        normalized.pop()
      }
      continue
    }

    normalized.push(segment)
  }

  return normalized.join("/")
}

function splitPath(path) {
  const normalizedPath = normalizeZipPath(path)
  const slashIndex = normalizedPath.lastIndexOf("/")
  const dir = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : ""
  const fileName = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath
  const dotIndex = fileName.lastIndexOf(".")
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const ext = dotIndex > 0 ? fileName.slice(dotIndex) : ".xhtml"

  return { dir, base, ext }
}

function toManifestHref(opfDir, fullPath) {
  const normalizedPath = normalizeZipPath(fullPath)
  const normalizedOpfDir = normalizeZipPath(opfDir)

  if (!normalizedOpfDir) {
    return normalizedPath
  }

  const prefix = `${normalizedOpfDir}/`
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length)
  }

  return normalizedPath
}

function getElementsByName(parent, localName) {
  const inOpfNamespace = Array.from(parent.getElementsByTagNameNS(OPF_NS, localName))
  if (inOpfNamespace.length > 0) {
    return inOpfNamespace
  }

  return Array.from(parent.getElementsByTagNameNS("*", localName))
}

function getPackageElement(opfDoc) {
  return getElementsByName(opfDoc, "package")[0] || null
}

function getManifestElement(opfDoc) {
  const packageElement = getPackageElement(opfDoc)
  if (!packageElement) {
    return null
  }

  return getElementsByName(packageElement, "manifest")[0] || null
}

function getSpineElement(opfDoc) {
  const packageElement = getPackageElement(opfDoc)
  if (!packageElement) {
    return null
  }

  return getElementsByName(packageElement, "spine")[0] || null
}

function findManifestItemElementById(opfDoc, id) {
  const manifestElement = getManifestElement(opfDoc)
  if (!manifestElement) {
    return null
  }

  for (const itemElement of getElementsByName(manifestElement, "item")) {
    const itemId = itemElement.getAttribute("id")?.trim()
    if (itemId === id) {
      return itemElement
    }
  }

  return null
}

function clearChildren(element) {
  while (element?.firstChild) {
    element.removeChild(element.firstChild)
  }
}

function createUniqueManifestId(manifest, baseId) {
  let nextId = String(baseId || "item").replace(/\s+/g, "-")
  let suffix = 1

  while (manifest.has(nextId)) {
    nextId = `${baseId}-${suffix}`
    suffix += 1
  }

  return nextId
}

function hasParserError(doc) {
  if (!doc) {
    return false
  }

  if (typeof doc.querySelector === "function") {
    return Boolean(doc.querySelector("parsererror"))
  }

  const parserErrorByTag = doc.getElementsByTagName("parsererror")[0]
  if (parserErrorByTag) {
    return true
  }

  return Boolean(doc.getElementsByTagNameNS("*", "parsererror")[0])
}

function parseDocument(content, mimeType) {
  if (typeof DOMParser === "undefined") {
    throw new Error("DOMParser is not available in this environment")
  }

  const parser = new DOMParser()
  return parser.parseFromString(String(content || ""), mimeType)
}

function parseXhtml(content) {
  const doc = parseDocument(content, "application/xhtml+xml")
  return {
    doc,
    valid: !hasParserError(doc),
  }
}

function ensureXmlDeclaration(content) {
  const asText = String(content || "")
  const withoutDeclaration = asText.replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, "")
  return `${XML_DECLARATION}\n${withoutDeclaration}`
}

function fixBareAmpersands(content) {
  return String(content || "").replace(
    /&(?!(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9._:-]*);)/g,
    "&amp;",
  )
}

function ensureVoidTagsSelfClosed(content) {
  let updated = String(content || "")

  for (const tag of VOID_TAGS) {
    const tagExpression = new RegExp(`<${tag}(\\s[^<>]*?)?>`, "gi")
    updated = updated.replace(tagExpression, (match, attrs = "") => {
      if (/\/\s*>$/.test(match)) {
        return match
      }

      return `<${tag}${attrs} />`
    })
  }

  return updated
}

function buildXhtmlFromHtmlDocument(htmlDoc) {
  if (typeof XMLSerializer === "undefined") {
    const headInner = htmlDoc.head ? htmlDoc.head.innerHTML : ""
    const bodyInner = htmlDoc.body ? htmlDoc.body.innerHTML : ""
    const fixedHead = ensureVoidTagsSelfClosed(fixBareAmpersands(headInner))
    const fixedBody = ensureVoidTagsSelfClosed(fixBareAmpersands(bodyInner))

    return `${XML_DECLARATION}\n<html xmlns="${XHTML_NS}"><head>${fixedHead}</head><body>${fixedBody}</body></html>`
  }

  const serializer = new XMLSerializer()
  const htmlRoot = htmlDoc.documentElement
  let serialized = serializer.serializeToString(htmlRoot)

  if (!/^<html\b[^>]*\bxmlns\s*=/.test(serialized)) {
    serialized = serialized.replace(/^<html\b/i, `<html xmlns="${XHTML_NS}"`)
  }

  serialized = ensureVoidTagsSelfClosed(fixBareAmpersands(serialized))
  return `${XML_DECLARATION}\n${serialized}`
}

function attemptXhtmlFix(content) {
  const cleaned = ensureVoidTagsSelfClosed(fixBareAmpersands(String(content || "")))
  const htmlDoc = parseDocument(cleaned, "text/html")
  const rebuilt = buildXhtmlFromHtmlDocument(htmlDoc)
  const normalized = ensureXmlDeclaration(rebuilt)
  const parsed = parseXhtml(normalized)

  if (parsed.valid) {
    return normalized
  }

  const fallback = ensureXmlDeclaration(cleaned)
  if (parseXhtml(fallback).valid) {
    return fallback
  }

  return null
}

function serializeXhtmlDocument(doc) {
  if (typeof XMLSerializer === "undefined") {
    throw new Error("XMLSerializer is not available in this environment")
  }

  const serializer = new XMLSerializer()
  const serialized = serializer.serializeToString(doc)
  return ensureXmlDeclaration(serialized)
}

function getHtmlElement(doc) {
  return (
    doc.getElementsByTagNameNS(XHTML_NS, "html")[0] ||
    doc.getElementsByTagName("html")[0] ||
    null
  )
}

function getHeadElement(doc) {
  return (
    doc.getElementsByTagNameNS(XHTML_NS, "head")[0] ||
    doc.getElementsByTagName("head")[0] ||
    null
  )
}

function getBodyElement(doc) {
  return (
    doc.getElementsByTagNameNS(XHTML_NS, "body")[0] ||
    doc.getElementsByTagName("body")[0] ||
    null
  )
}

function ensureBodyElement(doc) {
  const existingBody = getBodyElement(doc)
  if (existingBody) {
    return existingBody
  }

  let htmlElement = getHtmlElement(doc)
  if (!htmlElement) {
    htmlElement = doc.createElementNS(XHTML_NS, "html")
    htmlElement.setAttribute("xmlns", XHTML_NS)
    doc.appendChild(htmlElement)
  }

  const bodyElement = doc.createElementNS(XHTML_NS, "body")
  htmlElement.appendChild(bodyElement)
  return bodyElement
}

function collectHeadingElements(node, result) {
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType !== 1) {
      continue
    }

    const localName = String(child.localName || child.nodeName || "").toLowerCase()
    if (localName === "h1" || localName === "h2") {
      result.push(child)
    }

    collectHeadingElements(child, result)
  }
}

function getHeadingBoundaryNodes(bodyElement) {
  const headings = []
  collectHeadingElements(bodyElement, headings)
  const boundaries = []
  const seen = new Set()

  for (const heading of headings) {
    let boundary = heading

    while (boundary?.parentNode && boundary.parentNode !== bodyElement) {
      boundary = boundary.parentNode
    }

    if (!boundary || boundary.parentNode !== bodyElement) {
      continue
    }

    if (seen.has(boundary)) {
      continue
    }

    seen.add(boundary)
    boundaries.push(boundary)
  }

  return boundaries
}

function splitBodyIntoParts(bodyElement) {
  const boundaries = getHeadingBoundaryNodes(bodyElement)

  if (boundaries.length <= 1) {
    return []
  }

  const boundarySet = new Set(boundaries)
  const parts = []
  let currentPart = []
  let seenBoundary = false

  for (const child of Array.from(bodyElement.childNodes || [])) {
    if (boundarySet.has(child)) {
      if (seenBoundary && currentPart.length > 0) {
        parts.push(currentPart)
        currentPart = []
      }

      seenBoundary = true
    }

    currentPart.push(child.cloneNode(true))
  }

  if (currentPart.length > 0) {
    parts.push(currentPart)
  }

  if (parts.length <= 1) {
    return []
  }

  return parts
}

function buildSplitPath(epubData, sourcePath, partIndex, usedPaths) {
  const { dir, base, ext } = splitPath(sourcePath)
  let suffix = 0

  while (true) {
    const suffixPart = suffix === 0 ? "" : `_${suffix}`
    const fileName = `${base}_part${partIndex}${suffixPart}${ext}`
    const candidate = normalizeZipPath(dir ? `${dir}/${fileName}` : fileName)

    if (!usedPaths.has(candidate) && !epubData.zip.file(candidate)) {
      usedPaths.add(candidate)
      return candidate
    }

    suffix += 1
  }
}

function replaceManifestItems(epubData, oldItemId, nextItems) {
  const manifestElement = getManifestElement(epubData.opfDoc)
  if (!manifestElement) {
    return
  }

  const oldElement = findManifestItemElementById(epubData.opfDoc, oldItemId)

  for (const item of nextItems) {
    const itemElement = epubData.opfDoc.createElementNS(OPF_NS, "item")
    itemElement.setAttribute("id", item.id)
    itemElement.setAttribute("href", item.href)
    itemElement.setAttribute("media-type", item.mediaType)

    if (item.properties) {
      itemElement.setAttribute("properties", item.properties)
    }

    if (oldElement) {
      manifestElement.insertBefore(itemElement, oldElement)
    } else {
      manifestElement.appendChild(itemElement)
    }
  }

  if (oldElement?.parentNode) {
    oldElement.parentNode.removeChild(oldElement)
  }
}

function rewriteSpineElement(epubData) {
  const spineElement = getSpineElement(epubData.opfDoc)
  if (!spineElement) {
    return
  }

  clearChildren(spineElement)

  for (const spineItem of epubData.spine) {
    if (!spineItem?.idref) {
      continue
    }

    const itemref = epubData.opfDoc.createElementNS(OPF_NS, "itemref")
    itemref.setAttribute("idref", spineItem.idref)

    if (spineItem.linear && spineItem.linear !== "yes") {
      itemref.setAttribute("linear", spineItem.linear)
    }

    spineElement.appendChild(itemref)
  }
}

function removeManifestItemElement(opfDoc, itemId) {
  const itemElement = findManifestItemElementById(opfDoc, itemId)
  if (itemElement?.parentNode) {
    itemElement.parentNode.removeChild(itemElement)
  }
}

function createUniqueMergedPath(epubData, firstChapterPath) {
  const { dir, ext } = splitPath(firstChapterPath)
  let suffix = 0

  while (true) {
    const fileName =
      suffix === 0 ? `merged_chapters${ext || ".xhtml"}` : `merged_chapters_${suffix}${ext || ".xhtml"}`
    const candidate = normalizeZipPath(dir ? `${dir}/${fileName}` : fileName)

    if (!epubData.zip.file(candidate)) {
      return candidate
    }

    suffix += 1
  }
}

function buildSplitDocument(sourceDoc, partNodes) {
  const nextDoc = sourceDoc.cloneNode(true)
  const nextBody = getBodyElement(nextDoc)
  const htmlElement = getHtmlElement(nextDoc)

  if (htmlElement && !htmlElement.getAttribute("xmlns")) {
    htmlElement.setAttribute("xmlns", XHTML_NS)
  }

  if (!nextBody) {
    return null
  }

  clearChildren(nextBody)

  for (const node of partNodes) {
    if (typeof nextDoc.importNode === "function") {
      nextBody.appendChild(nextDoc.importNode(node, true))
    } else {
      nextBody.appendChild(node.cloneNode(true))
    }
  }

  return serializeXhtmlDocument(nextDoc)
}

function parseChapterForWork(content) {
  const parsed = parseXhtml(content)
  if (parsed.valid) {
    return parsed.doc
  }

  const fixed = attemptXhtmlFix(content)
  if (!fixed) {
    return null
  }

  const parsedFixed = parseXhtml(fixed)
  if (!parsedFixed.valid) {
    return null
  }

  return parsedFixed.doc
}

function validateEpubData(epubData) {
  return Boolean(epubData && epubData.manifest instanceof Map && Array.isArray(epubData.spine))
}

export async function reorderChapters(epubData) {
  if (!validateEpubData(epubData)) {
    return {
      reordered: 0,
      skipped: ["Invalid EPUB data"],
    }
  }

  const skipped = []
  const nextSpine = []

  for (const spineItem of epubData.spine) {
    const idref = spineItem?.idref

    if (!idref || !epubData.manifest.has(idref)) {
      const label = idref || "(missing idref)"
      skipped.push(label)
      console.warn(`[reorderChapters] Skipping spine item: ${label}`)
      continue
    }

    nextSpine.push({
      idref,
      linear: spineItem.linear || "yes",
    })
  }

  epubData.spine = nextSpine
  rewriteSpineElement(epubData)

  return {
    reordered: nextSpine.length,
    skipped,
  }
}

export async function validateXhtml(epubData) {
  const errors = []

  if (!validateEpubData(epubData)) {
    return {
      valid: 0,
      fixed: 0,
      errors: ["Invalid EPUB data"],
    }
  }

  let chapterFiles = []

  try {
    chapterFiles = getChapterFiles(epubData)
  } catch (error) {
    return {
      valid: 0,
      fixed: 0,
      errors: [`Failed to list chapter files: ${getErrorMessage(error)}`],
    }
  }

  let valid = 0
  let fixed = 0

  for (const chapter of chapterFiles) {
    const fullPath = chapter?.fullPath

    if (!fullPath) {
      errors.push("Skipping chapter with invalid path")
      continue
    }

    let content
    try {
      content = await getFileContent(epubData, fullPath)
    } catch (error) {
      errors.push(`Failed to read "${fullPath}": ${getErrorMessage(error)}`)
      continue
    }

    const parsed = parseXhtml(content)
    if (parsed.valid) {
      valid += 1
      continue
    }

    const fixedContent = attemptXhtmlFix(content)
    if (!fixedContent) {
      errors.push(`Failed to fix invalid XHTML: "${fullPath}"`)
      continue
    }

    if (!parseXhtml(fixedContent).valid) {
      errors.push(`XHTML is still invalid after fix: "${fullPath}"`)
      continue
    }

    try {
      setFileContent(epubData, fullPath, fixedContent)
      fixed += 1
    } catch (error) {
      errors.push(`Failed to write fixed XHTML "${fullPath}": ${getErrorMessage(error)}`)
    }
  }

  return {
    valid,
    fixed,
    errors,
  }
}

export async function splitChapters(epubData) {
  if (!validateEpubData(epubData)) {
    return {
      originalFiles: 0,
      resultFiles: 0,
    }
  }

  let chapterFiles = []

  try {
    chapterFiles = getChapterFiles(epubData)
  } catch {
    return {
      originalFiles: 0,
      resultFiles: 0,
    }
  }

  const originalFiles = chapterFiles.length
  const originalSpine = Array.from(epubData.spine)
  const splitReplacements = new Map()
  const usedPaths = new Set()

  for (const chapter of chapterFiles) {
    const manifestItem = epubData.manifest.get(chapter?.id)
    const fullPath = chapter?.fullPath

    if (!manifestItem || !fullPath) {
      continue
    }

    let content
    try {
      content = await getFileContent(epubData, fullPath)
    } catch (error) {
      console.warn(`[splitChapters] Failed to read "${fullPath}": ${getErrorMessage(error)}`)
      continue
    }

    const chapterDoc = parseChapterForWork(content)
    if (!chapterDoc) {
      console.warn(`[splitChapters] Failed to parse "${fullPath}"`)
      continue
    }

    const body = getBodyElement(chapterDoc)
    if (!body) {
      continue
    }

    const parts = splitBodyIntoParts(body)
    if (parts.length <= 1) {
      continue
    }

    const nextManifestItems = []
    const nextIds = []

    for (let index = 0; index < parts.length; index += 1) {
      const partNumber = index + 1
      const nextPath = buildSplitPath(epubData, fullPath, partNumber, usedPaths)
      const splitContent = buildSplitDocument(chapterDoc, parts[index])

      if (!splitContent) {
        nextManifestItems.length = 0
        break
      }

      const nextId = createUniqueManifestId(epubData.manifest, `${chapter.id}_part${partNumber}`)
      const nextHref = toManifestHref(epubData.opfDir, nextPath)

      nextManifestItems.push({
        id: nextId,
        href: nextHref,
        fullPath: nextPath,
        mediaType: manifestItem.mediaType || "application/xhtml+xml",
        properties: manifestItem.properties || null,
        content: splitContent,
      })

      nextIds.push(nextId)
    }

    if (nextManifestItems.length <= 1) {
      continue
    }

    for (const item of nextManifestItems) {
      setFileContent(epubData, item.fullPath, item.content)
      epubData.manifest.set(item.id, {
        id: item.id,
        href: item.href,
        fullPath: item.fullPath,
        mediaType: item.mediaType,
        properties: item.properties,
      })
    }

    replaceManifestItems(epubData, chapter.id, nextManifestItems)
    epubData.manifest.delete(chapter.id)
    splitReplacements.set(chapter.id, nextIds)

    if (fullPath !== nextManifestItems[0].fullPath) {
      epubData.zip.remove(fullPath)
    }
  }

  if (splitReplacements.size > 0) {
    const nextSpine = []

    for (const spineItem of originalSpine) {
      const replacementIds = splitReplacements.get(spineItem.idref)

      if (replacementIds && replacementIds.length > 0) {
        for (const replacementId of replacementIds) {
          nextSpine.push({
            idref: replacementId,
            linear: spineItem.linear || "yes",
          })
        }
        continue
      }

      if (!epubData.manifest.has(spineItem.idref)) {
        continue
      }

      nextSpine.push({
        idref: spineItem.idref,
        linear: spineItem.linear || "yes",
      })
    }

    epubData.spine = nextSpine
    rewriteSpineElement(epubData)
  }

  return {
    originalFiles,
    resultFiles: getChapterFiles(epubData).length,
  }
}

export async function mergeChapters(epubData) {
  if (!validateEpubData(epubData)) {
    return {
      mergedCount: 0,
      outputFile: "",
    }
  }

  let chapterFiles = []

  try {
    chapterFiles = getChapterFiles(epubData)
  } catch {
    return {
      mergedCount: 0,
      outputFile: "",
    }
  }

  if (chapterFiles.length === 0) {
    return {
      mergedCount: 0,
      outputFile: "",
    }
  }

  const parsedChapters = []

  for (const chapter of chapterFiles) {
    if (!chapter?.fullPath) {
      continue
    }

    try {
      const content = await getFileContent(epubData, chapter.fullPath)
      const chapterDoc = parseChapterForWork(content)

      if (!chapterDoc) {
        console.warn(`[mergeChapters] Skipping unparseable chapter "${chapter.fullPath}"`)
        continue
      }

      parsedChapters.push({
        chapter,
        doc: chapterDoc,
      })
    } catch (error) {
      console.warn(`[mergeChapters] Failed to read "${chapter.fullPath}": ${getErrorMessage(error)}`)
    }
  }

  if (parsedChapters.length === 0) {
    return {
      mergedCount: 0,
      outputFile: "",
    }
  }

  const sourceFirst = parsedChapters[0]
  const mergedDoc = sourceFirst.doc.cloneNode(true)
  const mergedBody = ensureBodyElement(mergedDoc)
  const mergedHtml = getHtmlElement(mergedDoc)

  if (mergedHtml && !mergedHtml.getAttribute("xmlns")) {
    mergedHtml.setAttribute("xmlns", XHTML_NS)
  }

  clearChildren(mergedBody)

  for (let index = 0; index < parsedChapters.length; index += 1) {
    const chapterBody = getBodyElement(parsedChapters[index].doc)

    if (chapterBody) {
      for (const node of Array.from(chapterBody.childNodes || [])) {
        if (typeof mergedDoc.importNode === "function") {
          mergedBody.appendChild(mergedDoc.importNode(node, true))
        } else {
          mergedBody.appendChild(node.cloneNode(true))
        }
      }
    }

    if (index < parsedChapters.length - 1) {
      mergedBody.appendChild(mergedDoc.createElementNS(XHTML_NS, "hr"))
    }
  }

  const outputFile = createUniqueMergedPath(epubData, sourceFirst.chapter.fullPath)
  const mergedContent = serializeXhtmlDocument(mergedDoc)
  setFileContent(epubData, outputFile, mergedContent)

  const mergedId = createUniqueManifestId(epubData.manifest, "merged-chapter")
  const mergedHref = toManifestHref(epubData.opfDir, outputFile)
  const mergedMediaType =
    epubData.manifest.get(sourceFirst.chapter.id)?.mediaType || "application/xhtml+xml"

  const manifestElement = getManifestElement(epubData.opfDoc)
  if (manifestElement) {
    const mergedItem = epubData.opfDoc.createElementNS(OPF_NS, "item")
    mergedItem.setAttribute("id", mergedId)
    mergedItem.setAttribute("href", mergedHref)
    mergedItem.setAttribute("media-type", mergedMediaType)
    manifestElement.appendChild(mergedItem)
  }

  epubData.manifest.set(mergedId, {
    id: mergedId,
    href: mergedHref,
    fullPath: outputFile,
    mediaType: mergedMediaType,
    properties: null,
  })

  const mergedIdSet = new Set(parsedChapters.map((entry) => entry.chapter.id))

  for (const entry of parsedChapters) {
    const oldId = entry.chapter.id
    const oldPath = entry.chapter.fullPath

    epubData.manifest.delete(oldId)
    removeManifestItemElement(epubData.opfDoc, oldId)

    if (oldPath && oldPath !== outputFile) {
      epubData.zip.remove(oldPath)
    }
  }

  const originalSpine = Array.from(epubData.spine)
  const nextSpine = []
  let insertedMerged = false

  for (const spineItem of originalSpine) {
    if (mergedIdSet.has(spineItem.idref)) {
      if (!insertedMerged) {
        nextSpine.push({
          idref: mergedId,
          linear: spineItem.linear || "yes",
        })
        insertedMerged = true
      }
      continue
    }

    if (!epubData.manifest.has(spineItem.idref)) {
      continue
    }

    nextSpine.push({
      idref: spineItem.idref,
      linear: spineItem.linear || "yes",
    })
  }

  if (!insertedMerged) {
    nextSpine.push({ idref: mergedId, linear: "yes" })
  }

  epubData.spine = nextSpine
  rewriteSpineElement(epubData)

  return {
    mergedCount: parsedChapters.length,
    outputFile,
  }
}
