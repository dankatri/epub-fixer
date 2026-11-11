import { getFileContent, setFileContent } from "./reader.js"

const DEFAULT_LIMIT = 50

/**
 * Snapshot-based undo stack for heading edits.
 *
 * Heading edits snapshot their XHTML files; imported TOC edits snapshot the
 * virtual marker list. Each snapshot restores the corresponding state exactly.
 */
export function createHistory(limit = DEFAULT_LIMIT) {
  const stack = []
  let changeHandler = null

  function notify() {
    if (changeHandler) {
      changeHandler()
    }
  }

  return {
    onChange(handler) {
      changeHandler = handler
    },

    get canUndo() {
      return stack.length > 0
    },

    get size() {
      return stack.length
    },

    /** Description of the edit that the next undo would reverse. */
    get nextLabel() {
      return stack.length > 0 ? stack[stack.length - 1].label : null
    },

    /** Record the current contents of `paths` before an edit is applied. */
    async capture(epubData, paths, label) {
      const uniquePaths = Array.from(new Set(paths))
      const entries = []

      for (const fullPath of uniquePaths) {
        entries.push({ fullPath, content: await getFileContent(epubData, fullPath) })
      }

      stack.push({ label, entries, chapterMarkers: null })

      while (stack.length > limit) {
        stack.shift()
      }

      notify()
    },

    /** Record the current virtual chapter markers before an edit is applied. */
    captureMarkers(epubData, label) {
      stack.push({
        label,
        entries: [],
        chapterMarkers: Array.isArray(epubData.chapterMarkers)
          ? epubData.chapterMarkers.map((marker) => ({ ...marker }))
          : null,
      })

      while (stack.length > limit) {
        stack.shift()
      }

      notify()
    },

    /** Restore the most recent snapshot. Returns its label, or null if empty. */
    undo(epubData) {
      const snapshot = stack.pop()
      if (!snapshot) {
        notify()
        return null
      }

      for (const { fullPath, content } of snapshot.entries) {
        setFileContent(epubData, fullPath, content)
      }
      if (snapshot.chapterMarkers) {
        epubData.chapterMarkers = snapshot.chapterMarkers.map((marker) => ({ ...marker }))
      }

      notify()
      return snapshot.label
    },

    clear() {
      stack.length = 0
      notify()
    },
  }
}
