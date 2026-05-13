import { initDropzone } from "./ui/dropzone.js"
import { initOptions, getOptions } from "./ui/options.js"
import { clearLog, log } from "./ui/log.js"
import { renderChapterHeadings, clearChapterHeadings } from "./ui/chapter-headings.js"

import { readEpub, getChapterFiles } from "./epub/reader.js"
import { writeEpub } from "./epub/writer.js"
import {
  extractHeadings,
  renameHeading,
  deleteHeading,
  changeHeadingLevel,
  reorderHeadings,
} from "./epub/headings.js"
import {
  reorderChapters,
  validateXhtml,
  splitChapters,
  mergeChapters,
} from "./epub/chapters.js"
import { rebuildToc } from "./epub/toc.js"
import { replaceCover } from "./epub/cover.js"
import { removeStrings } from "./epub/strings.js"

let epubData = null

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

function buildFixedFilename(originalFilename) {
  const safeName = String(originalFilename || "").trim()
  if (!safeName) {
    return "fixed.epub"
  }

  if (safeName.toLowerCase().endsWith(".epub")) {
    return `${safeName.slice(0, -5)}_fixed.epub`
  }

  return `${safeName}_fixed.epub`
}

document.addEventListener("DOMContentLoaded", () => {
  const optionsSection = getElement("options-section")
  const actionSection = getElement("action-section")
  const processButton = getElement("process-btn")
  const downloadButton = getElement("download-btn")
  const chapterHeadingsSection = getElement("chapter-headings-section")
  const chapterHeadingsList = getElement("chapter-headings-list")
  const rebuildTocCheckbox = getElement("opt-rebuild-toc")

  function markHeadingsEdited() {
    if (!rebuildTocCheckbox.checked) {
      rebuildTocCheckbox.checked = true
    }
  }

  async function refreshHeadingsPanel() {
    if (!epubData) return
    try {
      const chapters = await extractHeadings(epubData)
      renderChapterHeadings(chapterHeadingsList, chapters, headingCallbacks)
    } catch (error) {
      log(`Failed to refresh headings: ${getErrorMessage(error)}`, "warn")
    }
  }

  const headingCallbacks = {
    async onRename(chapterFullPath, headingId, newTitle) {
      try {
        await renameHeading(epubData, chapterFullPath, headingId, newTitle)
        log(`Renamed heading: "${newTitle}"`)
        markHeadingsEdited()
        await refreshHeadingsPanel()
      } catch (error) {
        log(`Rename failed: ${getErrorMessage(error)}`, "error")
        await refreshHeadingsPanel()
      }
    },
    async onDelete(chapterFullPath, headingId) {
      try {
        await deleteHeading(epubData, chapterFullPath, headingId)
        log("Deleted heading")
        markHeadingsEdited()
        await refreshHeadingsPanel()
      } catch (error) {
        log(`Delete failed: ${getErrorMessage(error)}`, "error")
        await refreshHeadingsPanel()
      }
    },
    async onChangeLevel(chapterFullPath, headingId, newLevel) {
      try {
        await changeHeadingLevel(epubData, chapterFullPath, headingId, newLevel)
        log(`Changed heading level to H${newLevel}`)
        markHeadingsEdited()
        await refreshHeadingsPanel()
      } catch (error) {
        log(`Level change failed: ${getErrorMessage(error)}`, "error")
        await refreshHeadingsPanel()
      }
    },
    async onReorder(chapterFullPath, newOrder) {
      try {
        await reorderHeadings(epubData, chapterFullPath, newOrder)
        log("Reordered headings")
        markHeadingsEdited()
        await refreshHeadingsPanel()
      } catch (error) {
        log(`Reorder failed: ${getErrorMessage(error)}`, "error")
        await refreshHeadingsPanel()
      }
    },
  }

  function resetUiState() {
    epubData = null
    optionsSection.hidden = true
    actionSection.hidden = true
    processButton.hidden = false
    processButton.disabled = false
    downloadButton.hidden = true
    chapterHeadingsSection.hidden = true
    clearChapterHeadings(chapterHeadingsList)
  }

  async function onFileSelected(file) {
    if (!file) {
      clearLog()
      resetUiState()
      return
    }

    clearLog()
    log(`Loading EPUB: ${file.name}`)

    try {
      const loadedEpub = await readEpub(file)
      loadedEpub.originalFilename = file.name
      epubData = loadedEpub

      const chapterFiles = getChapterFiles(loadedEpub)
      const title = loadedEpub.metadata?.title || "Unknown title"
      const author = loadedEpub.metadata?.author || "Unknown author"

      optionsSection.hidden = false
      actionSection.hidden = false
      processButton.hidden = false
      processButton.disabled = false
      downloadButton.hidden = true

      log(`Title: ${title}`, "success")
      log(`Author: ${author}`)
      log(`EPUB version: ${loadedEpub.version}`)
      log(`Chapter files: ${chapterFiles.length}`)

      // Extract and display chapter headings
      try {
        const chapters = await extractHeadings(loadedEpub)
        renderChapterHeadings(chapterHeadingsList, chapters, headingCallbacks)
        chapterHeadingsSection.hidden = false
        const totalHeadings = chapters.reduce((sum, ch) => sum + ch.headings.length, 0)
        log(`Headings found: ${totalHeadings}`)
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
          const result = await reorderChapters(epubData)
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
          const result = await validateXhtml(epubData)
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
          const result = await splitChapters(epubData)
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
          const result = await mergeChapters(epubData)
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
          const result = await rebuildToc(epubData)
          log(`TOC rebuilt with ${result.headingsFound} headings and ${result.navPoints} entries`, "success")
        } catch (error) {
          log(`TOC rebuild failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.replaceCover && options.coverFile) {
        log("Replacing cover image...")
        try {
          const result = await replaceCover(epubData, options.coverFile)
          const action = result.replaced ? "Replaced existing cover" : "Added new cover"
          log(`${action}: ${result.path}`, "success")
        } catch (error) {
          log(`Cover replacement failed: ${getErrorMessage(error)}`, "error")
        }
      }

      if (options.removeStrings) {
        log("Removing configured strings...")
        try {
          const result = await removeStrings(epubData, {
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

      log("All operations complete!", "success")
      downloadButton.hidden = false
      processButton.hidden = true
    } catch (error) {
      log(getErrorMessage(error), "error")
      processButton.disabled = false
    }
  }

  async function handleDownloadClick() {
    if (!epubData) {
      log("No EPUB loaded.", "warn")
      return
    }

    const filename = buildFixedFilename(epubData.originalFilename)

    try {
      await writeEpub(epubData, filename)
      log(`Download started: ${filename}`, "success")
    } catch (error) {
      log(getErrorMessage(error), "error")
    }
  }

  initDropzone(onFileSelected)
  initOptions()
  processButton.addEventListener("click", handleProcessClick)
  downloadButton.addEventListener("click", handleDownloadClick)
  resetUiState()
})
