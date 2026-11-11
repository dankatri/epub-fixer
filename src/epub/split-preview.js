import { cloneEpubData, getChapterFiles } from "./reader.js"
import { extractHeadings } from "./headings.js"
import { splitChapters } from "./chapters.js"

export async function createSplitPreview(source) {
  const originalPaths = new Set(getChapterFiles(source).map((chapter) => chapter.fullPath))
  const working = await cloneEpubData(source)
  const result = await splitChapters(working)
  const chapterFiles = getChapterFiles(working)
  let chapters
  const unresolvedMarkers = []

  if (Array.isArray(working.chapterMarkers)) {
    chapters = chapterFiles.map((chapter, chapterIndex) => ({
      chapterIndex,
      chapterHref: chapter.href,
      chapterFullPath: chapter.fullPath,
      headings: [],
    }))
    const chaptersByPath = new Map(
      chapters.map((chapter) => [chapter.chapterFullPath, chapter]),
    )

    for (const marker of working.chapterMarkers) {
      const chapter = chaptersByPath.get(marker.chapterFullPath)
      if (chapter) {
        chapter.headings.push(marker)
      } else {
        unresolvedMarkers.push(marker)
      }
    }
  } else {
    chapters = await extractHeadings(working)
  }

  for (const chapter of chapters) {
    chapter.isNewFile = !originalPaths.has(chapter.chapterFullPath)
  }

  return {
    originalFiles: result.originalFiles,
    resultFiles: result.resultFiles,
    chapters,
    unresolvedMarkers,
  }
}
