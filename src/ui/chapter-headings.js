const LEVEL_LABELS = { 1: "H1", 2: "H2", 3: "H3" }

function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag)

  for (const [key, value] of Object.entries(attrs)) {
    if (key === "className") {
      el.className = value
    } else if (key.startsWith("on")) {
      el.addEventListener(key.slice(2).toLowerCase(), value)
    } else {
      el.setAttribute(key, value)
    }
  }

  for (const child of children) {
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child))
    } else if (child) {
      el.appendChild(child)
    }
  }

  return el
}

function createIconButton(label, svgPath, onClick, extraClass = "") {
  const btn = createElement("button", {
    type: "button",
    title: label,
    "aria-label": label,
    className: `ch-icon-btn ${extraClass}`.trim(),
    onClick,
  })

  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPath}</svg>`
  return btn
}

function buildHeadingRow(heading, chapterFullPath, callbacks) {
  const row = createElement("div", {
    className: `ch-row ch-level-${heading.level}`,
    draggable: "true",
    "data-heading-id": heading.id,
    "data-chapter": chapterFullPath,
    "data-source": heading.source || "html",
    "data-level": String(heading.level),
  })

  // Selection checkbox for bulk operations
  const checkbox = createElement("input", {
    type: "checkbox",
    className: "ch-select",
    title: "Select heading for bulk actions",
    "aria-label": "Select heading",
  })
  checkbox.addEventListener("change", () => {
    row.classList.toggle("ch-selected", checkbox.checked)
    callbacks.onSelectionChange()
  })

  // Drag handle
  const dragHandle = createElement("span", { className: "ch-drag-handle", "aria-hidden": "true" })
  dragHandle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`

  // Level badge
  const badge = createElement("span", {
    className: "ch-level-badge",
    title: "Click to cycle heading level",
  }, [LEVEL_LABELS[heading.level] || "H?"])

  badge.addEventListener("click", () => {
    const nextLevel = (heading.level % 3) + 1
    if (heading.source === "toc" || heading.source === "styled") {
      callbacks.onMarkerChangeLevel(heading.id, nextLevel, heading.title)
    } else {
      callbacks.onChangeLevel(chapterFullPath, heading.id, nextLevel, heading.title)
    }
  })

  // Title (editable)
  const titleEl = createElement("span", {
    className: "ch-title",
    contentEditable: "true",
    spellcheck: "false",
  }, [heading.title])

  titleEl.addEventListener("blur", () => {
    const newTitle = titleEl.textContent.trim()
    if (newTitle && newTitle !== heading.title) {
      if (heading.source === "toc" || heading.source === "styled") {
        callbacks.onMarkerRename(heading.id, newTitle, heading.title)
      } else {
        callbacks.onRename(chapterFullPath, heading.id, newTitle, heading.title)
      }
    } else if (!newTitle) {
      titleEl.textContent = heading.title
    }
  })

  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      titleEl.blur()
    }
    if (e.key === "Escape") {
      titleEl.textContent = heading.title
      titleEl.blur()
    }
  })

  // Level up button
  const levelUp = heading.level > 1
    ? createIconButton(
        "Promote heading level",
        '<polyline points="18 15 12 9 6 15"/>',
        () => {
          if (heading.source === "toc" || heading.source === "styled") {
            callbacks.onMarkerChangeLevel(heading.id, heading.level - 1, heading.title)
          } else {
            callbacks.onChangeLevel(chapterFullPath, heading.id, heading.level - 1, heading.title)
          }
        },
        "ch-level-up",
      )
    : null

  // Level down button
  const levelDown = heading.level < 3
    ? createIconButton(
        "Demote heading level",
        '<polyline points="6 9 12 15 18 9"/>',
        () => {
          if (heading.source === "toc" || heading.source === "styled") {
            callbacks.onMarkerChangeLevel(heading.id, heading.level + 1, heading.title)
          } else {
            callbacks.onChangeLevel(chapterFullPath, heading.id, heading.level + 1, heading.title)
          }
        },
        "ch-level-down",
      )
    : null

  // Delete button
  const deleteBtn = createIconButton(
    "Delete heading",
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    () => {
      if (heading.source === "toc" || heading.source === "styled") {
        callbacks.onMarkerDelete(heading.id, heading.title)
      } else {
        callbacks.onDelete(chapterFullPath, heading.id, heading.title)
      }
    },
    "ch-delete",
  )

  // Dotted leader + page number
  const leader = createElement("span", { className: "ch-leader" })
  const pageNum = createElement("span", { className: "ch-page" }, [
    String(heading.page || ""),
  ])

  // Actions group
  const actions = createElement("span", { className: "ch-actions" })
  if (levelUp) actions.appendChild(levelUp)
  if (levelDown) actions.appendChild(levelDown)
  actions.appendChild(deleteBtn)

  row.appendChild(checkbox)
  row.appendChild(dragHandle)
  row.appendChild(badge)
  row.appendChild(titleEl)
  row.appendChild(leader)
  row.appendChild(pageNum)
  row.appendChild(actions)

  return row
}

function setupDragAndDrop(container, callbacks) {
  let draggedRow = null
  let draggedChapter = null

  container.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".ch-row")
    if (!row) return
    draggedRow = row
    draggedChapter = row.dataset.chapter
    row.classList.add("ch-dragging")
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData("text/plain", row.dataset.headingId)
  })

  container.addEventListener("dragend", (e) => {
    if (draggedRow) {
      draggedRow.classList.remove("ch-dragging")
    }
    draggedRow = null
    draggedChapter = null
    for (const el of container.querySelectorAll(".ch-drag-over")) {
      el.classList.remove("ch-drag-over")
    }
  })

  container.addEventListener("dragover", (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    const row = e.target.closest(".ch-row")
    if (!row || row === draggedRow) return
    if (row.dataset.chapter !== draggedChapter) return

    for (const el of container.querySelectorAll(".ch-drag-over")) {
      el.classList.remove("ch-drag-over")
    }
    row.classList.add("ch-drag-over")
  })

  container.addEventListener("drop", (e) => {
    e.preventDefault()
    const targetRow = e.target.closest(".ch-row")
    if (!targetRow || !draggedRow || targetRow === draggedRow) return
    if (targetRow.dataset.chapter !== draggedChapter) return

    const chapterFullPath = draggedChapter
    const chapterGroup = container.querySelector(
      `.ch-chapter-group[data-chapter="${CSS.escape(chapterFullPath)}"]`,
    )
    if (!chapterGroup) return

    const rows = Array.from(chapterGroup.querySelectorAll(".ch-row"))
    const dragIndex = rows.indexOf(draggedRow)
    const targetIndex = rows.indexOf(targetRow)

    if (dragIndex < 0 || targetIndex < 0) return

    // Move the DOM element
    if (dragIndex < targetIndex) {
      targetRow.after(draggedRow)
    } else {
      targetRow.before(draggedRow)
    }

    // Collect new order
    const newOrder = Array.from(chapterGroup.querySelectorAll(".ch-row")).map(
      (r) => r.dataset.headingId,
    )

    if (draggedRow.dataset.source === "toc" || draggedRow.dataset.source === "styled") {
      callbacks.onMarkerReorder(chapterFullPath, newOrder)
    } else {
      callbacks.onReorder(chapterFullPath, newOrder)
    }

    for (const el of container.querySelectorAll(".ch-drag-over")) {
      el.classList.remove("ch-drag-over")
    }
  })
}

function buildBulkToolbar(container, callbacks) {
  const toolbar = createElement("div", {
    className: "ch-bulk-toolbar",
    hidden: "",
  })

  const count = createElement("span", { className: "ch-bulk-count" }, ["0 selected"])

  const label = createElement("span", { className: "ch-bulk-label" }, ["Set level:"])

  const makeLevelBtn = (level) => {
    const btn = createElement("button", {
      type: "button",
      className: "ch-bulk-btn",
      title: `Change selected headings to ${LEVEL_LABELS[level]}`,
    }, [LEVEL_LABELS[level]])
    btn.addEventListener("click", () => {
      const updates = getSelectedRows(container).map((row) => ({
        chapterFullPath: row.dataset.chapter,
        headingId: row.dataset.headingId,
        newLevel: level,
        source: row.dataset.source,
      }))
      if (updates.length > 0) {
        callbacks.onBulkChangeLevel(updates)
      }
    })
    return btn
  }

  const clearBtn = createElement("button", {
    type: "button",
    className: "ch-bulk-btn ch-bulk-clear",
    title: "Clear selection",
  }, ["Clear"])
  clearBtn.addEventListener("click", () => {
    for (const cb of container.querySelectorAll(".ch-select:checked")) {
      cb.checked = false
      cb.closest(".ch-row")?.classList.remove("ch-selected")
    }
    updateBulkToolbar(container)
  })

  toolbar.appendChild(count)
  toolbar.appendChild(label)
  toolbar.appendChild(makeLevelBtn(1))
  toolbar.appendChild(makeLevelBtn(2))
  toolbar.appendChild(makeLevelBtn(3))
  toolbar.appendChild(clearBtn)

  return toolbar
}

function getSelectedRows(container) {
  return Array.from(container.querySelectorAll(".ch-select:checked")).map((cb) =>
    cb.closest(".ch-row"),
  ).filter(Boolean)
}

function updateBulkToolbar(container) {
  const toolbar = container.querySelector(".ch-bulk-toolbar")
  if (!toolbar) return
  const selected = container.querySelectorAll(".ch-select:checked").length
  const countEl = toolbar.querySelector(".ch-bulk-count")
  if (countEl) {
    countEl.textContent = `${selected} selected`
  }
  toolbar.hidden = selected === 0
}

export function renderChapterHeadings(container, chapters, callbacks) {
  container.textContent = ""

  const totalHeadings = chapters.reduce((sum, ch) => sum + ch.headings.length, 0)

  if (totalHeadings === 0) {
    const empty = createElement("p", { className: "ch-empty" }, [
      "No headings found in this EPUB.",
    ])
    container.appendChild(empty)
    return
  }

  const rowCallbacks = {
    ...callbacks,
    onSelectionChange: () => updateBulkToolbar(container),
  }

  container.appendChild(buildBulkToolbar(container, callbacks))

  for (const chapter of chapters) {
    if (chapter.headings.length === 0) {
      continue
    }

    const group = createElement("div", {
      className: "ch-chapter-group",
      "data-chapter": chapter.chapterFullPath,
    })

    const label = createElement("div", { className: "ch-chapter-label" }, [
      chapter.chapterHref,
    ])
    group.appendChild(label)

    for (const heading of chapter.headings) {
      group.appendChild(buildHeadingRow(heading, chapter.chapterFullPath, rowCallbacks))
    }

    container.appendChild(group)
  }

  setupDragAndDrop(container, callbacks)
}

export function clearChapterHeadings(container) {
  container.textContent = ""
}

export function renderSplitPreview(container, chapters) {
  container.textContent = ""

  if (chapters.length === 0) {
    container.appendChild(createElement("p", { className: "split-preview-empty" }, [
      "No chapter files found.",
    ]))
    return
  }

  const files = createElement("ol", { className: "split-preview-files" })
  for (const chapter of chapters) {
    const file = createElement("li", { className: "split-preview-file" })
    const fileHeader = createElement("div", { className: "split-preview-file-header" })
    fileHeader.appendChild(createElement("span", {
      className: "split-preview-filename",
      title: chapter.chapterHref,
    }, [chapter.chapterHref]))
    fileHeader.appendChild(createElement("span", {
      className: chapter.isNewFile ? "split-preview-file-badge is-new" : "split-preview-file-badge",
    }, [chapter.isNewFile ? "New file" : "Unchanged"]))
    file.appendChild(fileHeader)

    if (chapter.headings.length === 0) {
      file.appendChild(createElement("p", { className: "split-preview-empty" }, [
        "No chapter markers in this file.",
      ]))
    } else {
      const headings = createElement("ul", { className: "split-preview-markers" })
      for (const heading of chapter.headings) {
        const row = createElement("li", { className: "split-preview-marker" })
        row.appendChild(createElement("span", { className: "split-preview-level" }, [
          LEVEL_LABELS[heading.level] || "H?",
        ]))
        row.appendChild(createElement("span", { className: "split-preview-title" }, [
          heading.title,
        ]))
        headings.appendChild(row)
      }
      file.appendChild(headings)
    }

    files.appendChild(file)
  }
  container.appendChild(files)
}
