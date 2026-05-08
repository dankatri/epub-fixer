import JSZip from "jszip"

function parseXml(xmlText, sourceName) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, "text/xml")
  const parserError = doc.getElementsByTagName("parsererror")[0]

  if (parserError) {
    throw new Error(`Invalid XML in ${sourceName}`)
  }

  return doc
}

function getElementsByLocalName(parent, localName) {
  return Array.from(parent.getElementsByTagNameNS("*", localName))
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

function getFirstText(parent, localName) {
  const element = getElementsByLocalName(parent, localName)[0]
  return element?.textContent?.trim() || ""
}

export async function readEpub(file) {
  const zip = await JSZip.loadAsync(file)

  const mimetypeEntry = zip.file("mimetype")
  if (!mimetypeEntry) {
    throw new Error("Invalid EPUB: missing mimetype file")
  }

  const mimetype = (await mimetypeEntry.async("string")).trim()
  if (mimetype !== "application/epub+zip") {
    throw new Error(`Invalid EPUB: unexpected mimetype "${mimetype}"`)
  }

  const containerEntry = zip.file("META-INF/container.xml")
  if (!containerEntry) {
    throw new Error("Invalid EPUB: missing META-INF/container.xml")
  }

  const containerXml = await containerEntry.async("string")
  const containerDoc = parseXml(containerXml, "META-INF/container.xml")
  const rootfile = getElementsByLocalName(containerDoc, "rootfile")[0]
  const rootfilePath = rootfile?.getAttribute("full-path")?.trim()

  if (!rootfilePath) {
    throw new Error("Invalid EPUB: container.xml does not define rootfile full-path")
  }

  const opfPath = normalizeZipPath(rootfilePath)
  const opfEntry = zip.file(opfPath)
  if (!opfEntry) {
    throw new Error(`Invalid EPUB: OPF file not found at "${opfPath}"`)
  }

  const opfXml = await opfEntry.async("string")
  const opfDoc = parseXml(opfXml, opfPath)

  const packageElement = getElementsByLocalName(opfDoc, "package")[0]
  if (!packageElement) {
    throw new Error("Malformed OPF: missing <package> element")
  }

  const versionAttr = packageElement.getAttribute("version")?.trim() || ""
  let version
  if (versionAttr.startsWith("2")) {
    version = "2.0"
  } else if (versionAttr.startsWith("3")) {
    version = "3.0"
  } else {
    throw new Error(`Unsupported EPUB version "${versionAttr || "unknown"}"`)
  }

  const opfDirIndex = opfPath.lastIndexOf("/")
  const opfDir = opfDirIndex >= 0 ? opfPath.slice(0, opfDirIndex) : ""

  const manifestElement = getElementsByLocalName(packageElement, "manifest")[0]
  if (!manifestElement) {
    throw new Error("Malformed OPF: missing <manifest> element")
  }

  const manifest = new Map()
  for (const itemElement of getElementsByLocalName(manifestElement, "item")) {
    const id = itemElement.getAttribute("id")?.trim()
    const href = itemElement.getAttribute("href")?.trim()
    const mediaType = itemElement.getAttribute("media-type")?.trim() || ""
    const properties = itemElement.getAttribute("properties")

    if (!id || !href) {
      continue
    }

    manifest.set(id, {
      id,
      href,
      mediaType,
      fullPath: resolveManifestPath(opfDir, href),
      properties,
    })
  }

  const spineElement = getElementsByLocalName(packageElement, "spine")[0]
  if (!spineElement) {
    throw new Error("Malformed OPF: missing <spine> element")
  }

  const spine = []
  for (const itemrefElement of getElementsByLocalName(spineElement, "itemref")) {
    const idref = itemrefElement.getAttribute("idref")?.trim()
    if (!idref) {
      continue
    }

    spine.push({
      idref,
      linear: itemrefElement.getAttribute("linear")?.trim() || "yes",
    })
  }

  const metadataElement = getElementsByLocalName(packageElement, "metadata")[0]
  const title = metadataElement ? getFirstText(metadataElement, "title") : ""
  const author = metadataElement ? getFirstText(metadataElement, "creator") : ""
  const language = metadataElement ? getFirstText(metadataElement, "language") : ""

  let coverId = null

  if (metadataElement) {
    for (const metaElement of getElementsByLocalName(metadataElement, "meta")) {
      const nameAttr = metaElement.getAttribute("name")?.trim().toLowerCase()
      if (nameAttr === "cover") {
        const contentAttr = metaElement.getAttribute("content")?.trim()
        if (contentAttr) {
          coverId = contentAttr
          break
        }
      }
    }
  }

  if (!coverId) {
    for (const item of manifest.values()) {
      const properties = item.properties || ""
      const tokens = properties.split(/\s+/).filter(Boolean)
      if (tokens.includes("cover-image")) {
        coverId = item.id
        break
      }
    }
  }

  return {
    zip,
    opfPath,
    opfDir,
    version,
    metadata: {
      title,
      author,
      language,
      coverId,
    },
    manifest,
    spine,
    opfDoc,
  }
}

export function getChapterFiles(epubData) {
  const chapters = []

  for (const spineItem of epubData.spine) {
    const manifestItem = epubData.manifest.get(spineItem.idref)
    if (!manifestItem) {
      continue
    }

    const mediaType = (manifestItem.mediaType || "").toLowerCase()
    if (!mediaType.includes("xhtml") && !mediaType.includes("html")) {
      continue
    }

    chapters.push({
      id: manifestItem.id,
      href: manifestItem.href,
      fullPath: manifestItem.fullPath,
      mediaType: manifestItem.mediaType,
    })
  }

  return chapters
}

export async function getFileContent(epubData, fullPath) {
  const entry = epubData.zip.file(fullPath)
  if (!entry) {
    throw new Error(`File not found in EPUB: ${fullPath}`)
  }

  return entry.async("string")
}

export function setFileContent(epubData, fullPath, content) {
  epubData.zip.file(fullPath, content)
}
