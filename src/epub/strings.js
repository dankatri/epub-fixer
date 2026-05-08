import { getChapterFiles, getFileContent, setFileContent } from "./reader.js"
import { PRESETS } from "../presets.js"

function escapeLiteralRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string" && error.message) {
    return error.message
  }

  return String(error)
}

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item) => typeof item === "string" && item.length > 0)
}

function buildRegexPatterns(customStrings, regexMode, presetIds, errors) {
  const patterns = []

  for (const customString of customStrings) {
    if (!regexMode) {
      patterns.push(new RegExp(escapeLiteralRegex(customString), "g"))
      continue
    }

    try {
      patterns.push(new RegExp(customString, "g"))
    } catch (error) {
      errors.push(`Invalid regex pattern "${customString}": ${getErrorMessage(error)}`)
    }
  }

  const presetIdSet = new Set(presetIds)

  for (const preset of PRESETS) {
    if (!presetIdSet.has(preset.id)) {
      continue
    }

    const presetStrings = asStringArray(preset.strings)
    for (const presetString of presetStrings) {
      patterns.push(new RegExp(escapeLiteralRegex(presetString), "g"))
    }
  }

  return patterns
}

function applyPatterns(content, patterns) {
  let nextContent = content
  let removals = 0

  for (const pattern of patterns) {
    pattern.lastIndex = 0
    nextContent = nextContent.replace(pattern, () => {
      removals += 1
      return ""
    })
  }

  return {
    content: nextContent,
    removals,
  }
}

export async function removeStrings(epubData, options = {}) {
  const customStrings = asStringArray(options.customStrings)
  const presetIds = asStringArray(options.presetIds)
  const regexMode = Boolean(options.regexMode)

  if (customStrings.length === 0 && presetIds.length === 0) {
    return { filesModified: 0, totalRemovals: 0 }
  }

  const errors = []
  const patterns = buildRegexPatterns(customStrings, regexMode, presetIds, errors)

  if (patterns.length === 0) {
    return {
      filesModified: 0,
      totalRemovals: 0,
      errors,
    }
  }

  let filesModified = 0
  let totalRemovals = 0
  const chapterFiles = getChapterFiles(epubData)

  for (const chapterFile of chapterFiles) {
    const fullPath = chapterFile.fullPath

    let originalContent
    try {
      originalContent = await getFileContent(epubData, fullPath)
    } catch (error) {
      errors.push(`Failed to read "${fullPath}": ${getErrorMessage(error)}`)
      continue
    }

    const { content: updatedContent, removals } = applyPatterns(originalContent, patterns)

    if (updatedContent === originalContent) {
      continue
    }

    try {
      setFileContent(epubData, fullPath, updatedContent)
    } catch (error) {
      errors.push(`Failed to write "${fullPath}": ${getErrorMessage(error)}`)
      continue
    }

    filesModified += 1
    totalRemovals += removals
  }

  return {
    filesModified,
    totalRemovals,
    errors,
  }
}
