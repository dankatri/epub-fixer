import JSZip from "jszip"
import { cloneEpubData, getChapterFiles, getFileContent, readEpub } from "../src/epub/reader.js"
import { extractHeadings } from "../src/epub/headings.js"
import { extractTocMarkers } from "../src/epub/toc.js"
import { splitChapters } from "../src/epub/chapters.js"
import { createSplitPreview } from "../src/epub/split-preview.js"

const results = document.getElementById("results")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function makeBook(markers) {
  const useNav = markers === "nav"
  const zip = new JSZip()
  zip.file("mimetype", "application/epub+zip")
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`)
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="${useNav ? "3.0" : "2.0"}" unique-identifier="book-id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">fixture</dc:identifier><dc:title>Preview fixture</dc:title>
      </metadata>
      <manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
        <item id="other" href="other.xhtml" media-type="application/xhtml+xml"/>
        ${useNav
          ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
          : markers ? '<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ""}
      </manifest>
      <spine${markers && !useNav ? ' toc="toc"' : ""}><itemref idref="chapter"/><itemref idref="other"/></spine>
    </package>`)
  const body = markers
    ? `<div><span id="one">First</span></div><p>First text.</p>
       <div><span id="two">Second</span></div><p>Second text.</p>
       <div><span id="three">Third</span></div><p>Third text.</p>`
    : `<h1 id="one">First</h1><p>First text.</p>
       <h2 id="two">Second</h2><p>Second text.</p><h3 id="three">Third</h3>`
  zip.file("OEBPS/chapter.xhtml", `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head>
    <body><p>Opening text.</p>${body}</body></html>`)
  zip.file("OEBPS/other.xhtml", `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Other</title></head>
    <body><p>An unchanged file.</p></body></html>`)
  zip.file("OEBPS/chapter_part1.xhtml", "Existing non-spine file")
  if (useNav) {
    zip.file("OEBPS/nav.xhtml", `<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <head><title>Contents</title></head><body><nav epub:type="toc"><ol>
          <li><a href="chapter.xhtml#one">First</a></li>
          <li><a href="chapter.xhtml#two">Second</a><ol>
            <li><a href="chapter.xhtml#three">Third</a></li>
          </ol></li>
        </ol></nav></body>
      </html>`)
  } else if (markers) {
    zip.file("OEBPS/toc.ncx", `<?xml version="1.0"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
        <navPoint id="n1"><navLabel><text>First</text></navLabel><content src="chapter.xhtml#one"/></navPoint>
        <navPoint id="n2"><navLabel><text>Second</text></navLabel><content src="chapter.xhtml#two"/>
          <navPoint id="n3"><navLabel><text>Third</text></navLabel><content src="chapter.xhtml#three"/></navPoint>
        </navPoint>
      </navMap></ncx>`)
  }
  return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" })
}

async function checkPreviewModel(blob, markers) {
  const book = await readEpub(blob)
  await extractHeadings(book)
  if (markers) {
    book.chapterMarkers = await extractTocMarkers(book)
    assert(book.chapterMarkers.length === 3, "TOC markers should be imported")
    assert(book.chapterMarkers[2].level === 2, "Nested TOC marker levels should be preserved")
  }

  const originalContent = await getFileContent(book, "OEBPS/chapter.xhtml")
  const originalMarkers = JSON.stringify(book.chapterMarkers)
  const preview = await createSplitPreview(book)
  const actual = await cloneEpubData(book)
  await splitChapters(actual)

  assert(preview.originalFiles === 2, "Preview should count the original files")
  assert(
    preview.resultFiles === (markers ? 4 : 3),
    `Preview should count the split files (markers=${markers}, got ${preview.resultFiles})`,
  )
  assert(
    JSON.stringify(preview.chapters.map((chapter) => chapter.chapterHref)) ===
      JSON.stringify(getChapterFiles(actual).map((chapter) => chapter.href)),
    "Preview paths should match the real split",
  )
  assert(preview.chapters[0].chapterHref === "chapter_part1_1.xhtml", "Preview should respect filename collisions")
  assert(preview.chapters[0].headings[0].title === "First", "First marker should be in the first part")
  assert(preview.chapters[1].headings[0].title === "Second", "Second marker should be in the second part")
  if (!markers) {
    assert(preview.chapters[1].headings[1].title === "Third", "H3 should remain with the preceding H2")
  }
  assert(!preview.chapters.at(-1).isNewFile, "Unchanged files should remain visible")
  assert(await getFileContent(book, "OEBPS/chapter.xhtml") === originalContent, "Preview must not edit source content")
  assert(JSON.stringify(book.chapterMarkers) === originalMarkers, "Preview must not edit source markers")
  assert(getChapterFiles(book).length === 2, "Preview must not change the source spine")

  if (markers) {
    book.chapterMarkers.push({
      id: "missing",
      targetId: "missing",
      chapterFullPath: "OEBPS/chapter.xhtml",
      chapterIndex: 0,
      title: "Missing",
      level: 1,
    })
    const withMissing = await createSplitPreview(book)
    assert(withMissing.unresolvedMarkers.length === 1, "Preview should report unresolved markers")

    book.chapterMarkers = []
    const withoutBoundaries = await createSplitPreview(book)
    assert(withoutBoundaries.resultFiles === 2, "A book without split boundaries should remain unchanged")
  }
}

async function checkPreviewUi(markerBlob, headingBlob) {
  const frame = document.getElementById("app")
  if (
    frame.contentDocument?.readyState !== "complete" ||
    !frame.contentDocument?.getElementById("opt-split")
  ) {
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }))
  }
  const win = frame.contentWindow
  const doc = frame.contentDocument
  const input = doc.getElementById("file-input")
  const split = doc.getElementById("opt-split")
  const merge = doc.getElementById("opt-merge")
  const panel = doc.getElementById("split-preview")
  const summary = doc.getElementById("split-preview-summary")

  function selectBook(blob, name) {
    const files = new win.DataTransfer()
    files.items.add(new win.File([blob], name, { type: "application/epub+zip" }))
    input.files = files.files
    input.dispatchEvent(new win.Event("change", { bubbles: true }))
  }

  selectBook(markerBlob, "markers.epub")
  await waitFor(
    () => doc.querySelectorAll("#chapter-headings-list .ch-row").length === 3,
    `Markers did not load: ${doc.getElementById("log").textContent}`,
  )
  assert(panel.hidden, "Preview should be hidden before split is selected")
  split.click()
  await waitFor(() => summary.textContent.includes("2 → 4") && !panel.hasAttribute("aria-busy"), "Split preview did not appear")
  assert(doc.querySelectorAll(".split-preview-file").length === 4, "Preview should show every resulting file")
  assert(doc.querySelectorAll(".split-preview-marker").length === 3, "Preview should show the markers in their parts")
  assert(doc.querySelectorAll("#chapter-headings-list .ch-row").length === 3, "The original editor should remain available")

  const title = doc.querySelector("#chapter-headings-list .ch-title")
  title.textContent = "Renamed"
  title.dispatchEvent(new win.FocusEvent("blur"))
  await waitFor(() => Array.from(doc.querySelectorAll(".split-preview-title")).some((item) => item.textContent === "Renamed"), "Preview did not refresh after editing")
  doc.getElementById("headings-undo-btn").click()
  await waitFor(() => Array.from(doc.querySelectorAll(".split-preview-title")).some((item) => item.textContent === "First"), "Preview did not refresh after undo")
  doc.querySelector("#chapter-headings-list .ch-delete").click()
  await waitFor(() => summary.textContent.includes("2 → 3") && !panel.hasAttribute("aria-busy"), "Preview did not refresh after deleting a marker")
  doc.getElementById("headings-undo-btn").click()
  await waitFor(() => summary.textContent.includes("2 → 4") && !panel.hasAttribute("aria-busy"), "Preview did not restore the split after undo")

  merge.click()
  assert(summary.textContent.includes("Both operations will be skipped"), "Preview should explain the merge conflict")
  merge.click()
  split.click()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert(panel.hidden, "Preview should stay hidden after split is deselected")
  split.click()
  await waitFor(() => summary.textContent.includes("2 → 4") && !panel.hasAttribute("aria-busy"), "Preview did not return after selecting split")

  selectBook(headingBlob, "headings.epub")
  await waitFor(() => summary.textContent.includes("2 → 3") && !panel.hasAttribute("aria-busy"), "Preview did not update for the next EPUB")
  doc.getElementById("process-btn").click()
  await waitFor(() => !doc.getElementById("download-btn").hidden, "EPUB processing did not finish")
  assert(doc.getElementById("log").textContent.includes("2 files -> 3 files"), "Processed split should match the preview")
}

async function run() {
  const markerBlob = await makeBook(true)
  const headingBlob = await makeBook(false)
  const navBlob = await makeBook("nav")
  await checkPreviewModel(markerBlob, true)
  await checkPreviewModel(navBlob, true)
  await checkPreviewModel(headingBlob, false)
  await checkPreviewUi(markerBlob, headingBlob)
  results.dataset.status = "pass"
  results.textContent = "PASS: split preview model and UI"
}

run().catch((error) => {
  results.dataset.status = "fail"
  results.textContent = `FAIL: ${error.stack || error.message || error}`
})
