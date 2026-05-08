const OPF_NS = "http://www.idpf.org/2007/opf"
const COVER_PROPERTY = "cover-image"

const COMMON_COVER_FILE_NAMES = new Set([
  "cover.jpg",
  "cover.jpeg",
  "cover.png",
  "cover-image.jpg",
  "cover-image.jpeg",
  "cover-image.png",
  "coverimage.jpg",
  "coverimage.jpeg",
  "coverimage.png",
  "frontcover.jpg",
  "frontcover.jpeg",
  "frontcover.png",
])

function getElementsByName(parent, localName) {
  const inOpfNamespace = Array.from(parent.getElementsByTagNameNS(OPF_NS, localName))

  if (inOpfNamespace.length > 0) {
    return inOpfNamespace
  }

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

function getFileName(path) {
  const normalizedPath = normalizeZipPath(String(path || ""))
  const lastSlashIndex = normalizedPath.lastIndexOf("/")

  if (lastSlashIndex < 0) {
    return normalizedPath
  }

  return normalizedPath.slice(lastSlashIndex + 1)
}

function getPathExtension(path) {
  const fileName = getFileName(path)
  const dotIndex = fileName.lastIndexOf(".")

  if (dotIndex <= 0) {
    return ""
  }

  return fileName.slice(dotIndex).toLowerCase()
}

function replacePathExtension(path, newExtension) {
  const normalizedPath = normalizeZipPath(path)
  const slashIndex = normalizedPath.lastIndexOf("/")
  const fileName = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath
  const directory = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex + 1) : ""
  const dotIndex = fileName.lastIndexOf(".")
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName

  return `${directory}${baseName}${newExtension}`
}

function hasCoverProperty(item) {
  const tokens = String(item?.properties || "")
    .split(/\s+/)
    .filter(Boolean)

  return tokens.includes(COVER_PROPERTY)
}

function toCoverInfo(item) {
  if (!item) {
    return null
  }

  return {
    id: item.id,
    href: item.href,
    fullPath: item.fullPath,
    mediaType: item.mediaType,
  }
}

function getPackageElement(opfDoc) {
  const packageElement = getElementsByName(opfDoc, "package")[0]

  if (!packageElement) {
    throw new Error("Malformed OPF: missing <package> element")
  }

  return packageElement
}

function getManifestElement(opfDoc) {
  const packageElement = getPackageElement(opfDoc)
  const manifestElement = getElementsByName(packageElement, "manifest")[0]

  if (!manifestElement) {
    throw new Error("Malformed OPF: missing <manifest> element")
  }

  return manifestElement
}

function getMetadataElement(opfDoc) {
  const packageElement = getPackageElement(opfDoc)
  return getElementsByName(packageElement, "metadata")[0] || null
}

function ensureMetadataElement(opfDoc) {
  const packageElement = getPackageElement(opfDoc)
  const existingMetadata = getMetadataElement(opfDoc)
  if (existingMetadata) {
    return existingMetadata
  }

  const metadataElement = opfDoc.createElementNS(OPF_NS, "metadata")
  const manifestElement = getElementsByName(packageElement, "manifest")[0]

  if (manifestElement) {
    packageElement.insertBefore(metadataElement, manifestElement)
  } else {
    packageElement.appendChild(metadataElement)
  }

  return metadataElement
}

function findManifestItemElementById(opfDoc, id) {
  const manifestElement = getManifestElement(opfDoc)
  const itemElements = getElementsByName(manifestElement, "item")

  for (const itemElement of itemElements) {
    const itemId = itemElement.getAttribute("id")?.trim()

    if (itemId === id) {
      return itemElement
    }
  }

  return null
}

function upsertCoverMeta(opfDoc, coverId) {
  const metadataElement = ensureMetadataElement(opfDoc)
  const metaElements = getElementsByName(metadataElement, "meta")

  for (const metaElement of metaElements) {
    const name = metaElement.getAttribute("name")?.trim().toLowerCase()

    if (name === "cover") {
      metaElement.setAttribute("content", coverId)
      return
    }
  }

  const metaElement = opfDoc.createElementNS(OPF_NS, "meta")
  metaElement.setAttribute("name", "cover")
  metaElement.setAttribute("content", coverId)
  metadataElement.appendChild(metaElement)
}

function isImageMediaType(mediaType) {
  return String(mediaType || "").toLowerCase().startsWith("image/")
}

function getNewImageDetails(newImageFile) {
  if (!newImageFile || typeof newImageFile.arrayBuffer !== "function") {
    throw new Error("replaceCover requires a valid File object")
  }

  const mediaType = String(newImageFile.type || "").trim().toLowerCase()

  if (mediaType === "image/jpeg" || mediaType === "image/jpg") {
    return { mediaType: "image/jpeg", extension: ".jpg" }
  }

  if (mediaType === "image/png") {
    return { mediaType, extension: ".png" }
  }

  const fileName = String(newImageFile.name || "").toLowerCase()

  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
    return { mediaType: "image/jpeg", extension: ".jpg" }
  }

  if (fileName.endsWith(".png")) {
    return { mediaType: "image/png", extension: ".png" }
  }

  throw new Error("Unsupported cover image format. Please use JPG or PNG.")
}

function createUniqueManifestId(manifest, baseId) {
  let nextId = baseId
  let suffix = 1

  while (manifest.has(nextId)) {
    nextId = `${baseId}-${suffix}`
    suffix += 1
  }

  return nextId
}

function createUniqueCoverPath(epubData, extension) {
  let suffix = 0

  while (true) {
    const fileName = suffix === 0 ? `cover${extension}` : `cover-${suffix}${extension}`
    const href = `images/${fileName}`
    const fullPath = resolveManifestPath(epubData.opfDir, href)

    if (!epubData.zip.file(fullPath)) {
      return fullPath
    }

    suffix += 1
  }
}

export function detectCover(epubData) {
  const coverId = epubData?.metadata?.coverId

  if (coverId) {
    const coverItem = epubData.manifest.get(coverId)
    if (coverItem) {
      return toCoverInfo(coverItem)
    }
  }

  for (const item of epubData.manifest.values()) {
    if (hasCoverProperty(item)) {
      return toCoverInfo(item)
    }
  }

  for (const item of epubData.manifest.values()) {
    if (!isImageMediaType(item.mediaType)) {
      continue
    }

    const hrefFileName = getFileName(item.href).toLowerCase()
    const fullPathFileName = getFileName(item.fullPath).toLowerCase()

    if (
      COMMON_COVER_FILE_NAMES.has(hrefFileName) ||
      COMMON_COVER_FILE_NAMES.has(fullPathFileName)
    ) {
      return toCoverInfo(item)
    }
  }

  return null
}

export async function replaceCover(epubData, newImageFile) {
  const imageDetails = getNewImageDetails(newImageFile)
  const imageBytes = await newImageFile.arrayBuffer()
  const existingCover = detectCover(epubData)

  if (existingCover) {
    const manifestItem = epubData.manifest.get(existingCover.id)
    if (!manifestItem) {
      throw new Error(`Cover manifest item not found: ${existingCover.id}`)
    }

    const currentExtension = getPathExtension(manifestItem.fullPath)
    const extensionChanged = currentExtension !== imageDetails.extension
    const nextFullPath = extensionChanged
      ? replacePathExtension(manifestItem.fullPath, imageDetails.extension)
      : manifestItem.fullPath
    const nextHref = extensionChanged
      ? toManifestHref(epubData.opfDir, nextFullPath)
      : manifestItem.href

    epubData.zip.file(nextFullPath, imageBytes)

    if (extensionChanged && nextFullPath !== manifestItem.fullPath) {
      epubData.zip.remove(manifestItem.fullPath)
    }

    const manifestItemElement = findManifestItemElementById(epubData.opfDoc, manifestItem.id)
    if (!manifestItemElement) {
      throw new Error(`Malformed OPF: missing manifest <item> for id "${manifestItem.id}"`)
    }

    if (manifestItem.mediaType !== imageDetails.mediaType) {
      manifestItemElement.setAttribute("media-type", imageDetails.mediaType)
    }

    if (extensionChanged) {
      manifestItemElement.setAttribute("href", nextHref)
    }

    manifestItem.href = nextHref
    manifestItem.fullPath = nextFullPath
    manifestItem.mediaType = imageDetails.mediaType
    epubData.manifest.set(manifestItem.id, manifestItem)
    epubData.metadata.coverId = manifestItem.id

    return {
      replaced: true,
      path: nextFullPath,
    }
  }

  const newCoverId = createUniqueManifestId(epubData.manifest, "cover-image")
  const newFullPath = createUniqueCoverPath(epubData, imageDetails.extension)
  const newHref = toManifestHref(epubData.opfDir, newFullPath)
  const manifestElement = getManifestElement(epubData.opfDoc)
  const newItemElement = epubData.opfDoc.createElementNS(OPF_NS, "item")

  newItemElement.setAttribute("id", newCoverId)
  newItemElement.setAttribute("href", newHref)
  newItemElement.setAttribute("media-type", imageDetails.mediaType)

  if (String(epubData.version || "").startsWith("3")) {
    newItemElement.setAttribute("properties", COVER_PROPERTY)
  }

  manifestElement.appendChild(newItemElement)
  upsertCoverMeta(epubData.opfDoc, newCoverId)

  epubData.zip.file(newFullPath, imageBytes)
  epubData.manifest.set(newCoverId, {
    id: newCoverId,
    href: newHref,
    fullPath: newFullPath,
    mediaType: imageDetails.mediaType,
    properties: String(epubData.version || "").startsWith("3") ? COVER_PROPERTY : null,
  })
  epubData.metadata.coverId = newCoverId

  return {
    replaced: false,
    path: newFullPath,
  }
}
