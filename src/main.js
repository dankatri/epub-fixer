import { initDropzone } from "./ui/dropzone.js"
import { initOptions, getOptions } from "./ui/options.js"
import { clearLog, log } from "./ui/log.js"
import { renderChapterHeadings, clearChapterHeadings } from "./ui/chapter-headings.js"

import { readEpub, getChapterFiles } from "./epub/reader.js"
import { convertPdfToEpub } from "./pdf/convert.js"
import { writeEpub } from "./epub/writer.js"
import {
  extractHeadings,
  renameHeading,
  deleteHeading,
  changeHeadingLevel,
  changeHeadingLevels,
  reorderHeadings,
  renameChapterMarker,
  deleteChapterMarker,
  changeChapterMarkerLevel,
  changeChapterMarkerLevels,
  reorderChapterMarkers,
  extractStyledTitleMarkers,
} from "./epub/headings.js"
import {
  reorderChapters,
  validateXhtml,
  splitChapters,
  mergeChapters,
} from "./epub/chapters.js"
import { extractTocMarkers, rebuildToc } from "./epub/toc.js"
import { replaceCover } from "./epub/cover.js"
import { removeStrings } from "./epub/strings.js"
import { createHistory } from "./epub/history.js"

let epubData = null
let fixedEpub = null

const headingHistory = createHistory()

function getElement(id) {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Missing required element: #${id}`)
  }
  return element
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string" && error.message) {
    return error.message
  }
  return String(error)
}

function sanitizeBaseName(value) {
  let base = String(value || "").trim()
  if (base.toLowerCase().endsWith(".epub")) {
    base = base.slice(0, -5)
  }
  return base.replace(/[/\\:*?"<>|]/g, "_").trim()
}

function defaultBaseName(loadedEpub) {
  const fromTitle = sanitizeBaseName(loadedEpub?.metadata?.title)
  if (fromTitle) {
    return fromTitle
  }
  const fromFile = sanitizeBaseName(loadedEpub?.originalFilename)
  return fromFile || "fixed"
}

function buildFixedFilename(rawName, fallbackBase) {
  let base = sanitizeBaseName(rawName)
  if (!base) {
    base = sanitizeBaseName(fallbackBase) || "fixed"
  }
  return `${base}.epub`
}

async function cloneEpubData(source) {
  const blob = await source.zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
  })
  const clone = await readEpub(blob)
  clone.originalFilename = source.originalFilename
  if (Array.isArray(source.chapterMarkers)) {
    clone.chapterMarkers = source.chapterMarkers.map((marker) => ({ ...marker }))
  }
  return clone
}

function groupChapterMarkers(markers, chapterFiles) {
  const chapters = chapterFiles.map((chapter, chapterIndex) => ({
    chapterIndex,
    chapterHref: chapter.href,
    chapterFullPath: chapter.fullPath,
    headings: [],
  }))

  for (const marker of markers) {
    const chapter = chapters[marker.chapterIndex]
    if (chapter) {
      chapter.headings.push(marker)
    }
  }

  return chapters
}

document.addEventListener("DOMContentLoaded", () => {
  const optionsSection = getElement("options-section")
  const actionSection = getElement("action-section")
  const processButton = getElement("process-btn")
  const downloadButton = getElement("download-btn")
  const chapterHeadingsSection = getElement("chapter-headings-section")
  const chapterHeadingsList = getElement("chapter-headings-list")
  const undoButton = getElement("headings-undo-btn")
  const rebuildTocCheckbox = getElement("opt-rebuild-toc")
  const filenameInput = getElement("opt-filename")
  const processButtonLabel = processButton.querySelector(".btn-label")

  function setProcessLabel(text) {
    if (processButtonLabel) {
      processButtonLabel.textContent = text
    }
  }

  // Mark a previously fixed result as out of date so the user is nudged to
  // re-run "Fix" after changing options or editing headings — no re-upload needed.
  function markFixStale() {
    if (!fixedEpub) return
    fixedEpub = null
    downloadButton.hidden = true
    setProcessLabel("Fix EPUB")
  }

  function markHeadingsEdited() {
    if (!rebuildTocCheckbox.checked) {
      rebuildTocCheckbox.checked = true
    }
    markFixStale()
  }

  async function refreshHeadingsPanel() {
    if (!epubData) return
    try {
      const chapters = Array.isArray(epubData.chapterMarkers)
        ? groupChapterMarkers(epubData.chapterMarkers, getChapterFiles(epubData))
        : await extractHeadings(epubData)
      renderChapterHeadings(chapterHeadingsList, chapters, headingCallbacks)
    } catch (error) {
      log(`Failed to refresh headings: ${getErrorMessage(error)}`, "warn")
    }
  }

  function updateUndoButton() {
    const label = headingHistory.nextLabel
    undoButton.disabled = !label
    undoButton.title = label ? `Undo ${label}` : "Nothing to undo"
  }

  headingHistory.onChange(updateUndoButton)

  /**
   * Run a heading mutation with undo support: snapshot the affected chapter
   * files first, then apply the edit. A failed edit is rolled back to the
   * snapshot so a partially applied change can never be left behind.
   */
  async function runHeadingEdit({ paths, label, apply, success, failure }) {
    if (!epubData) return

    let captured = false
    try {
      await headingHistory.capture(epubData, paths, label)
      captured = true
      await apply()
      log(success)
      markHeadingsEdited()
    } catch (error) {
      if (captured) {
        headingHistory.undo(epubData)
      }
      log(`${failure}: ${getErrorMessage(error)}`, "error")
    }

    await refreshHeadingsPanel()
  }

  async function runMarkerEdit({ label, apply, success, failure }) {
    if (!epubData) return

    try {
      headingHistory.captureMarkers(epubData, label)
      apply()
      log(success)
      markHeadingsEdited()
    } catch (error) {
      headingHistory.undo(epubData)
      log(`${failure}: ${getErrorMessage(error)}`, "error")
    }

    await refreshHeadingsPanel()
  }

  async function handleUndoClick() {
    if (!epubData || !headingHistory.canUndo) {
      return
    }

    const label = headingHistory.undo(epubData)
    log(`Undid ${label}`)
    markHeadingsEdited()
    await refreshHeadingsPanel()
  }

  const headingCallbacks = {
    async onMarkerRename(markerId, newTitle, oldTitle) {
      await runMarkerEdit({
        label: `rename of "${oldTitle || newTitle}"`,
        apply: () => renameChapterMarker(epubData, markerId, newTitle),
        success: `Renamed chapter marker: "${newTitle}"`,
        failure: "Rename failed",
      })
    },
    async onMarkerDelete(markerId, title) {
      await runMarkerEdit({
        label: title ? `deletion of "${title}"` : "chapter marker deletion",
        apply: () => deleteChapterMarker(epubData, markerId),
        success: title ? `Deleted chapter marker: "${title}"` : "Deleted chapter marker",
        failure: "Delete failed",
      })
    },
    async onMarkerChangeLevel(markerId, newLevel, title) {
      await runMarkerEdit({
        label: title ? `level change of "${title}"` : "chapter marker level change",
        apply: () => changeChapterMarkerLevel(epubData, markerId, newLevel),
        success: `Changed chapter marker level to H${newLevel}`,
        failure: "Level change failed",
      })
    },
    async onMarkerReorder(chapterFullPath, newOrder) {
      await runMarkerEdit({
        label: "chapter marker reorder",
        apply: () => reorderChapterMarkers(epubData, chapterFullPath, newOrder),
        success: "Reordered chapter markers",
        failure: "Reorder failed",
      })
    },
    async onRename(chapterFullPath, headingId, newTitle, oldTitle) {
      await runHeadingEdit({
        paths: [chapterFullPath],
        label: `rename of "${oldTitle || newTitle}"`,
        apply: () => renameHeading(epubData, chapterFullPath, headingId, newTitle),
        success: `Renamed heading: "${newTitle}"`,
        failure: "Rename failed",
      })
    },
    async onDelete(chapterFullPath, headingId, title) {
      await runHeadingEdit({
        paths: [chapterFullPath],
        label: title ? `deletion of "${title}"` : "heading deletion",
        apply: () => deleteHeading(epubData, chapterFullPath, headingId),
        success: title ? `Deleted heading: "${title}"` : "Deleted heading",
        failure: "Delete failed",
      })
    },
    async onChangeLevel(chapterFullPath, headingId, newLevel, title) {
      await runHeadingEdit({
        paths: [chapterFullPath],
        label: title ? `level change of "${title}"` : "heading level change",
        apply: () => changeHeadingLevel(epubData, chapterFullPath, headingId, newLevel),
        success: `Changed heading level to H${newLevel}`,
        failure: "Level change failed",
      })
    },
    async onBulkChangeLevel(updates) {
      const count = updates.length
      const newLevel = updates[0].newLevel
      if (updates.every((update) => update.source === "toc" || update.source === "styled")) {
        await runMarkerEdit({
          label: `level change of ${count} chapter marker${count === 1 ? "" : "s"}`,
          apply: () => changeChapterMarkerLevels(epubData, updates),
          success: `Changed ${count} chapter marker${count === 1 ? "" : "s"} to H${newLevel}`,
          failure: "Bulk level change failed",
        })
        return
      }
      await runHeadingEdit({
        paths: updates.map((update) => update.chapterFullPath),
        label: `level change of ${count} heading${count === 1 ? "" : "s"}`,
        apply: () => changeHeadingLevels(epubData, updates),
        success: `Changed ${count} heading${count === 1 ? "" : "s"} to H${newLevel}`,
        failure: "Bulk level change failed",
      })
    },
    async onReorder(chapterFullPath, newOrder) {
      await runHeadingEdit({
        paths: [chapterFullPath],
        label: "heading reorder",
        apply: () => reorderHeadings(epubData, chapterFullPath, newOrder),
        success: "Reordered headings",
        failure: "Reorder failed",
      })
    },
  }

  function resetUiState() {
    epubData = null
    fixedEpub = null
    optionsSection.hidden = true
    actionSection.hidden = true
    processButton.hidden = false
    processButton.disabled = false
    setProcessLabel("Fix EPUB")
    downloadButton.hidden = true
    filenameInput.value = ""
    chapterHeadingsSection.hidden = true
    headingHistory.clear()
    clearChapterHeadings(chapterHeadingsList)
  }

  async function onFileSelected(file) {
    if (!file) {
      clearLog()
      resetUiState()
      return
    }

    clearLog()

    const isPdf =
      file.type === "application/pdf" || /\.pdf$/i.test(file.name || "")

    try {
      let sourceFile = file
      let originalFilename = file.name

      if (isPdf) {
        log(`Converting PDF to EPUB: ${file.name}`)
        const epubBlob = await convertPdfToEpub(file, (message) => log(message))
        sourceFile = epubBlob
        originalFilename = file.name.replace(/\.pdf$/i, ".epub")
        log("PDF converted to EPUB", "success")
      } else {
        log(`Loading EPUB: ${file.name}`)
      }

      const loadedEpub = await readEpub(sourceFile)
      loadedEpub.originalFilename = originalFilename
      epubData = loadedEpub
      fixedEpub = null
      headingHistory.clear()

      const chapterFiles = getChapterFiles(loadedEpub)
      const title = loadedEpub.metadata?.title || "Unknown title"
      const author = loadedEpub.metadata?.author || "Unknown author"

      optionsSection.hidden = false
      actionSection.hidden = false
      processButton.hidden = false
      processButton.disabled = false
      setProcessLabel("Fix EPUB")
      downloadButton.hidden = true
      filenameInput.value = defaultBaseName(loadedEpub)

      log(`Title: ${title}`, "success")
      log(`Author: ${author}`)
      log(`EPUB version: ${loadedEpub.version}`)
      log(`Chapter files: ${chapterFiles.length}`)

      // Extract and display chapter headings
      try {
        let chapters = await extractHeadings(loadedEpub)
        const headingCount = chapters.reduce((sum, ch) => sum + ch.headings.length, 0)
        const tocMarkers = await extractTocMarkers(loadedEpub)

        if (tocMarkers.length > headingCount) {
          loadedEpub.chapterMarkers = tocMarkers
          chapters = groupChapterMarkers(tocMarkers, chapterFiles)
        } else if (headingCount === 0) {
          chapters = await extractStyledTitleMarkers(loadedEpub)
          loadedEpub.chapterMarkers = chapters.flatMap((chapter) => chapter.headings)
        }

        renderChapterHeadings(chapterHeadingsList, chapters, headingCallbacks)
        chapterHeadingsSection.hidden = false
        const totalHeadings = chapters.reduce((sum, ch) => sum + ch.headings.length, 0)
        log(`Chapter markers found: ${totalHeadings}`)
      } catch (headingError) {
        log(`Could not extract headings: ${getErrorMessage(headingError)}`, "warn")
      }
    } catch (error) {
      log(getErrorMessage(error), "error")
      resetUiState()
    }
  }

  async function handleProcessClick() {
    if (!epubData) {
      log("No EPUB loaded.", "warn")
      return
    }

    processButton.disabled = true

    let working
    try {
      // Work on a fresh clone of the loaded EPUB (plus any heading edits) so the
      // user can tweak options and re-run "Fix" without re-uploading, and without
      // operations stacking on top of a previous run.
      working = await cloneEpubData(epubData)
    } catch (error) {
      log(`Failed to prepare EPUB: ${getErrorMessage(error)}`, "error")
      processButton.disabled = false
      return
    }

    try {
      const options = getOptions()

      if (options.split && options.merge) {
        log("Split and merge cannot both run. Skipping both operations.", "warn")
        options.split = false
        options.merge = false
      }

      if (options.reorder) {
        log("Reordering chapters...")
        try {
          const result = await reorderChapters(working)
          log(`Reordered chapters: ${result.reordered}`, "success")
          if (result.skipped?.length) {
            log(`Skipped: ${result.skipped.join(", ")}`, "warn")
          }
        } catch (error) {
          log(`Reorder failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.validate) {
        log("Validating XHTML...")
        try {
          const result = await validateXhtml(working)
          log(`Valid XHTML files: ${result.valid}`, "success")
          log(`Fixed XHTML files: ${result.fixed}`, "success")
          if (result.errors?.length) {
            for (const error of result.errors) {
              log(error, "error")
            }
          }
        } catch (error) {
          log(`Validation failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.split) {
        log("Splitting chapters...")
        try {
          const result = await splitChapters(working)
          log(
            `Split complete: ${result.originalFiles} files -> ${result.resultFiles} files`,
            "success",
          )
        } catch (error) {
          log(`Split failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.merge) {
        log("Merging chapters...")
        try {
          const result = await mergeChapters(working)
          log(`Merged chapter files: ${result.mergedCount}`, "success")
          if (result.outputFile) {
            log(`Merged output file: ${result.outputFile}`)
          }
        } catch (error) {
          log(`Merge failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.rebuildToc) {
        log("Rebuilding table of contents...")
        try {
          const result = await rebuildToc(working)
          log(`TOC rebuilt with ${result.headingsFound} chapter markers and ${result.navPoints} entries`, "success")
        } catch (error) {
          log(`TOC rebuild failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.replaceCover && options.coverFile) {
        log("Replacing cover image...")
        try {
          const result = await replaceCover(working, options.coverFile)
          const action = result.replaced ? "Replaced existing cover" : "Added new cover"
          log(`${action}: ${result.path}`, "success")
        } catch (error) {
          log(`Cover replacement failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.removeStrings) {
        log("Removing configured strings...")
        try {
          const result = await removeStrings(working, {
            customStrings: options.customStrings,
            regexMode: options.regexMode,
            presetIds: options.presetIds,
          })
          log(`Files modified: ${result.filesModified}`, "success")
          log(`Total removals: ${result.totalRemovals}`, "success")
          if (result.errors?.length) {
            for (const error of result.errors) {
              log(error, "error")
            }
          }
        } catch (error) {
          log(`String removal failed: ${getErrorMessage(error)}`, "error")
        }
      }

      fixedEpub = working
      log("All operations complete!", "success")
      downloadButton.hidden = false
      setProcessLabel("Re-fix EPUB")
    } catch (error) {
      log(getErrorMessage(error), "error")
    } finally {
      processButton.disabled = false
    }
  }

  async function handleDownloadClick() {
    const target = fixedEpub || epubData
    if (!target) {
      log("No EPUB loaded.", "warn")
      return
    }

    const filename = buildFixedFilename(filenameInput.value, defaultBaseName(target))

    try {
      await writeEpub(target, filename)
      log(`Download started: ${filename}`, "success")
    } catch (error) {
      log(getErrorMessage(error), "error")
    }
  }

  initDropzone(onFileSelected)
  initOptions()
  processButton.addEventListener("click", handleProcessClick)
  downloadButton.addEventListener("click", handleDownloadClick)
  undoButton.addEventListener("click", handleUndoClick)

  // Ctrl/Cmd+Z undoes the last heading edit, unless the user is typing — the
  // heading titles are contenteditable and own their native undo behaviour.
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
    if (String(event.key).toLowerCase() !== "z") return

    const target = event.target
    if (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      return
    }

    if (!epubData || !headingHistory.canUndo) return

    event.preventDefault()
    handleUndoClick()
  })

  // Changing any option after a fix invalidates the result; nudge a re-fix.
  optionsSection.addEventListener("change", markFixStale)
  resetUiState()
})
