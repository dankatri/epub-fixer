import { getChapterFiles, getFileContent, setFileContent } from "./reader.js"
import {
  parseChapterDocument,
  collectHeadingElements,
  normalizeWhitespace,
} from "./headings.js"

const OPF_NS = "http://www.idpf.org/2007/opf"
const NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"
const XHTML_NS = "http://www.w3.org/1999/xhtml"
const EPUB_NS = "http://www.idpf.org/2007/ops"

const NCX_MEDIA_TYPE = "application/x-dtbncx+xml"
const NAV_MEDIA_TYPE = "application/xhtml+xml"

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

function resolveManifestPath(opfDir, href) {
  const hrefPath = normalizeZipPath(String(href || "").split("#")[0].split("?")[0])

  if (!hrefPath) {
    return normalizeZipPath(opfDir)
  }

  if (!opfDir) {
    return hrefPath
  }

  return normalizeZipPath(`${opfDir}/${hrefPath}`)
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

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function collectChapterEntries(chapter, chapterIndex, content) {
  const chapterDoc = parseChapterDocument(content)
  const headingElements = collectHeadingElements(chapterDoc)
  const entries = []
  let headingsFound = 0

  for (const headingElement of headingElements) {
    const tagName = String(headingElement.localName || headingElement.nodeName || "").toLowerCase()
    const level = Number(tagName.slice(1))
    if (level < 1 || level > 3) {
      continue
    }

    const title = normalizeWhitespace(headingElement.textContent)
    if (!title) {
      continue
    }

    const id = String(headingElement.getAttribute("id") || "").trim()
    const href = `${chapter.href || ""}${id ? `#${id}` : ""}`

    entries.push({
      level,
      title,
      href,
    })
    headingsFound += 1
  }

  if (entries.length === 0) {
    entries.push({
      level: 1,
      title: `Chapter ${chapterIndex + 1}`,
      href: chapter.href || "",
    })
  }

  return {
    entries,
    headingsFound,
  }
}

function buildTocTree(flatEntries) {
  const roots = []
  let currentH1 = null
  let currentH2 = null

  for (const entry of flatEntries) {
    const node = {
      title: entry.title,
      href: entry.href,
      children: [],
    }

    if (entry.level === 1) {
      roots.push(node)
      currentH1 = node
      currentH2 = null
      continue
    }

    if (entry.level === 2) {
      if (currentH1) {
        currentH1.children.push(node)
      } else {
        roots.push(node)
      }
      currentH2 = node
      continue
    }

    if (currentH2) {
      currentH2.children.push(node)
    } else if (currentH1) {
      currentH1.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

function countNodes(nodes) {
  let count = 0

  for (const node of nodes) {
    count += 1
    count += countNodes(node.children || [])
  }

  return count
}

function renderNcxNavPoints(nodes, state, indentLevel = 2) {
  const lines = []
  const indent = "  ".repeat(indentLevel)

  for (const node of nodes) {
    const playOrder = state.nextPlayOrder
    state.nextPlayOrder += 1
    const childrenXml = renderNcxNavPoints(node.children || [], state, indentLevel + 1)

    lines.push(`${indent}<navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">`)
    lines.push(`${indent}  <navLabel><text>${escapeXml(node.title)}</text></navLabel>`)
    lines.push(`${indent}  <content src="${escapeXml(node.href)}"/>`)
    if (childrenXml) {
      lines.push(childrenXml)
    }
    lines.push(`${indent}</navPoint>`)
  }

  return lines.join("\n")
}

function buildNcxXml(tocTree, uid, title) {
  const navMapContent = renderNcxNavPoints(tocTree, { nextPlayOrder: 1 })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ncx xmlns="${NCX_NS}" version="2005-1">`,
    "  <head>",
    `    <meta name="dtb:uid" content="${escapeXml(uid)}"/>`,
    "  </head>",
    `  <docTitle><text>${escapeXml(title)}</text></docTitle>`,
    "  <navMap>",
    navMapContent,
    "  </navMap>",
    "</ncx>",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function renderNavOl(nodes, indentLevel = 3) {
  const indent = "  ".repeat(indentLevel)
  const lines = []

  for (const node of nodes) {
    lines.push(`${indent}<li>`)
    lines.push(`${indent}  <a href="${escapeXml(node.href)}">${escapeXml(node.title)}</a>`)
    if (node.children && node.children.length > 0) {
      lines.push(`${indent}  <ol>`)
      lines.push(renderNavOl(node.children, indentLevel + 2))
      lines.push(`${indent}  </ol>`)
    }
    lines.push(`${indent}</li>`)
  }

  return lines.join("\n")
}

function buildNavXhtml(tocTree, title) {
  const listContent = renderNavOl(tocTree)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}">`,
    "  <head>",
    `    <title>${escapeXml(title)}</title>`,
    "  </head>",
    "  <body>",
    '    <nav epub:type="toc">',
    "      <ol>",
    listContent,
    "      </ol>",
    "    </nav>",
    "  </body>",
    "</html>",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function splitProperties(properties) {
  return String(properties || "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function hasPropertyToken(properties, token) {
  return splitProperties(properties).includes(token)
}

function addPropertyToken(properties, token) {
  const tokens = splitProperties(properties)
  if (!tokens.includes(token)) {
    tokens.push(token)
  }
  return tokens.join(" ")
}

function getPackageElement(opfDoc) {
  const packageElement = getElementsByName(opfDoc, "package")[0]
  if (!packageElement) {
    throw new Error("Malformed OPF: missing <package> element")
  }

  return packageElement
}

function ensureManifestElement(opfDoc) {
  const packageElement = getPackageElement(opfDoc)
  const existingManifest = getElementsByName(packageElement, "manifest")[0]

  if (existingManifest) {
    return existingManifest
  }

  const manifestElement = opfDoc.createElementNS(OPF_NS, "manifest")
  const spineElement = getElementsByName(packageElement, "spine")[0]

  if (spineElement) {
    packageElement.insertBefore(manifestElement, spineElement)
  } else {
    packageElement.appendChild(manifestElement)
  }

  return manifestElement
}

function ensureSpineElement(opfDoc) {
  const packageElement = getPackageElement(opfDoc)
  const existingSpine = getElementsByName(packageElement, "spine")[0]

  if (existingSpine) {
    return existingSpine
  }

  const spineElement = opfDoc.createElementNS(OPF_NS, "spine")
  packageElement.appendChild(spineElement)
  return spineElement
}

function findManifestItemElementById(manifestElement, id) {
  const itemElements = getElementsByName(manifestElement, "item")

  for (const itemElement of itemElements) {
    const itemId = itemElement.getAttribute("id")?.trim()
    if (itemId === id) {
      return itemElement
    }
  }

  return null
}

function createUniqueManifestId(manifest, baseId) {
  let nextId = String(baseId || "item")
  let suffix = 1

  while (manifest.has(nextId)) {
    nextId = `${baseId}-${suffix}`
    suffix += 1
  }

  return nextId
}

function findManifestItem(manifest, predicate) {
  for (const item of manifest.values()) {
    if (predicate(item)) {
      return item
    }
  }

  return null
}

function upsertManifestItem(epubData, options) {
  const manifestElement = ensureManifestElement(epubData.opfDoc)
  const existingItem = options.existingItem || null
  const id = existingItem?.id || createUniqueManifestId(epubData.manifest, options.baseId)
  const href = options.href
  const fullPath = options.fullPath
  const mediaType = options.mediaType
  const properties = options.properties || null

  let itemElement = findManifestItemElementById(manifestElement, id)
  if (!itemElement) {
    itemElement = epubData.opfDoc.createElementNS(OPF_NS, "item")
    manifestElement.appendChild(itemElement)
  }

  itemElement.setAttribute("id", id)
  itemElement.setAttribute("href", href)
  itemElement.setAttribute("media-type", mediaType)

  if (properties) {
    itemElement.setAttribute("properties", properties)
  } else {
    itemElement.removeAttribute("properties")
  }

  const nextItem = {
    id,
    href,
    fullPath,
    mediaType,
    properties,
  }

  epubData.manifest.set(id, nextItem)
  return nextItem
}

function getBookUid(epubData) {
  const metadataUid = normalizeWhitespace(epubData?.metadata?.identifier)
  if (metadataUid) {
    return metadataUid
  }

  const opfDoc = epubData?.opfDoc
  if (!opfDoc) {
    return "urn:uuid:unknown"
  }

  const packageElement = getElementsByName(opfDoc, "package")[0]
  const metadataElement = packageElement ? getElementsByName(packageElement, "metadata")[0] : null

  if (!metadataElement) {
    return "urn:uuid:unknown"
  }

  const identifierElements = getElementsByName(metadataElement, "identifier")
  const uniqueIdentifierId = packageElement?.getAttribute("unique-identifier")?.trim()

  if (uniqueIdentifierId) {
    for (const identifierElement of identifierElements) {
      const id = identifierElement.getAttribute("id")?.trim()
      if (id !== uniqueIdentifierId) {
        continue
      }

      const identifierValue = normalizeWhitespace(identifierElement.textContent)
      if (identifierValue) {
        return identifierValue
      }
    }
  }

  for (const identifierElement of identifierElements) {
    const identifierValue = normalizeWhitespace(identifierElement.textContent)
    if (identifierValue) {
      return identifierValue
    }
  }

  return "urn:uuid:unknown"
}

function resolveNcxTarget(epubData) {
  const existingNcxItem = findManifestItem(
    epubData.manifest,
    (item) => String(item?.mediaType || "").toLowerCase() === NCX_MEDIA_TYPE,
  )

  if (existingNcxItem) {
    return {
      existingItem: existingNcxItem,
      href: existingNcxItem.href,
      fullPath: existingNcxItem.fullPath || resolveManifestPath(epubData.opfDir, existingNcxItem.href),
    }
  }

  const defaultFullPath = normalizeZipPath(epubData.opfDir ? `${epubData.opfDir}/toc.ncx` : "toc.ncx")
  const defaultHref = toManifestHref(epubData.opfDir, defaultFullPath)
  const existingByHref = findManifestItem(
    epubData.manifest,
    (item) => normalizeZipPath(item?.href) === normalizeZipPath(defaultHref),
  )

  return {
    existingItem: existingByHref,
    href: existingByHref?.href || defaultHref,
    fullPath: existingByHref?.fullPath || defaultFullPath,
  }
}

function resolveNavTarget(epubData) {
  const existingNavItem = findManifestItem(
    epubData.manifest,
    (item) => hasPropertyToken(item?.properties, "nav"),
  )

  if (existingNavItem) {
    return {
      existingItem: existingNavItem,
      href: existingNavItem.href,
      fullPath: existingNavItem.fullPath || resolveManifestPath(epubData.opfDir, existingNavItem.href),
    }
  }

  const defaultFullPath = normalizeZipPath(epubData.opfDir ? `${epubData.opfDir}/nav.xhtml` : "nav.xhtml")
  const defaultHref = toManifestHref(epubData.opfDir, defaultFullPath)
  const existingByHref = findManifestItem(
    epubData.manifest,
    (item) => normalizeZipPath(item?.href) === normalizeZipPath(defaultHref),
  )

  return {
    existingItem: existingByHref,
    href: existingByHref?.href || defaultHref,
    fullPath: existingByHref?.fullPath || defaultFullPath,
  }
}

function getFallbackHref(epubData) {
  for (const spineItem of Array.isArray(epubData?.spine) ? epubData.spine : []) {
    const manifestItem = epubData?.manifest?.get?.(spineItem?.idref)
    if (!manifestItem?.href) {
      continue
    }

    return manifestItem.href
  }

  return ""
}

export async function rebuildToc(epubData) {
  const chapterFiles = getChapterFiles(epubData)
  const flatEntries = []
  let headingsFound = 0

  for (let chapterIndex = 0; chapterIndex < chapterFiles.length; chapterIndex += 1) {
    const chapter = chapterFiles[chapterIndex]
    const content = await getFileContent(epubData, chapter.fullPath)
    const chapterEntries = collectChapterEntries(chapter, chapterIndex, content)

    headingsFound += chapterEntries.headingsFound
    flatEntries.push(...chapterEntries.entries)
  }

  if (flatEntries.length === 0) {
    flatEntries.push({
      level: 1,
      title: "Chapter 1",
      href: getFallbackHref(epubData),
    })
  }

  const tocTree = buildTocTree(flatEntries)
  const navPoints = countNodes(tocTree)
  const bookTitle = normalizeWhitespace(epubData?.metadata?.title) || "Untitled"
  const bookUid = getBookUid(epubData)

  const ncxTarget = resolveNcxTarget(epubData)
  const navTarget = resolveNavTarget(epubData)

  const ncxItem = upsertManifestItem(epubData, {
    existingItem: ncxTarget.existingItem,
    href: ncxTarget.href,
    fullPath: ncxTarget.fullPath,
    mediaType: NCX_MEDIA_TYPE,
    properties: ncxTarget.existingItem?.properties || null,
    baseId: "ncx",
  })

  const navItem = upsertManifestItem(epubData, {
    existingItem: navTarget.existingItem,
    href: navTarget.href,
    fullPath: navTarget.fullPath,
    mediaType: NAV_MEDIA_TYPE,
    properties: addPropertyToken(navTarget.existingItem?.properties, "nav"),
    baseId: "nav",
  })

  const version = String(epubData?.version || "")
  const spineElement = ensureSpineElement(epubData.opfDoc)
  if (version.startsWith("2")) {
    spineElement.setAttribute("toc", ncxItem.id)
  }

  const ncxContent = buildNcxXml(tocTree, bookUid, bookTitle)
  const navContent = buildNavXhtml(tocTree, bookTitle)

  setFileContent(epubData, ncxItem.fullPath, ncxContent)
  setFileContent(epubData, navItem.fullPath, navContent)

  return {
    headingsFound,
    navPoints,
  }
}
