import JSZip from "jszip"

function buildDefaultFilename(epubData) {
  const originalFilename = String(
    epubData?.originalFilename || epubData?.filename || epubData?.fileName || "",
  ).trim()

  if (!originalFilename) {
    return "fixed.epub"
  }

  if (originalFilename.toLowerCase().endsWith(".epub")) {
    return `${originalFilename.slice(0, -5)}_fixed.epub`
  }

  return `${originalFilename}_fixed.epub`
}

function resolveDownloadFilename(epubData, filename) {
  if (typeof filename === "string" && filename.trim()) {
    return filename.trim()
  }

  return buildDefaultFilename(epubData)
}

export async function writeEpub(epubData, filename) {
  if (!epubData?.zip || !epubData?.opfPath || !epubData?.opfDoc) {
    throw new Error("writeEpub requires epubData with zip, opfPath, and opfDoc")
  }

  const serializedOpf = new XMLSerializer().serializeToString(epubData.opfDoc)
  epubData.zip.file(epubData.opfPath, serializedOpf)

  epubData.zip.remove("mimetype")

  const rebuiltZip = new JSZip()
  rebuiltZip.file("mimetype", "application/epub+zip", {
    compression: "STORE",
  })

  const entryNames = Object.keys(epubData.zip.files)
  for (const entryName of entryNames) {
    const entry = epubData.zip.files[entryName]

    if (entry.name === "mimetype") {
      continue
    }

    if (entry.dir) {
      rebuiltZip.folder(entry.name)
      continue
    }

    const bytes = await entry.async("uint8array")
    rebuiltZip.file(entry.name, bytes, {
      compression: entry.options?.compression || undefined,
      date: entry.date,
    })
  }

  const blob = await rebuiltZip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
  })

  const downloadFilename = resolveDownloadFilename(epubData, filename)
  const objectUrl = URL.createObjectURL(blob)
  const downloadLink = document.createElement("a")

  downloadLink.href = objectUrl
  downloadLink.download = downloadFilename
  downloadLink.style.display = "none"
  document.body.appendChild(downloadLink)
  downloadLink.click()
  downloadLink.remove()

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, 1000)
}
