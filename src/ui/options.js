import { PRESETS } from "../presets.js";

function getElement(id) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }

  return element;
}

export function initOptions() {
  const replaceCoverCheckbox = getElement("opt-replace-cover");
  const coverUploadArea = getElement("cover-upload-area");
  const removeStringsCheckbox = getElement("opt-remove-strings");
  const stringRemovalArea = getElement("string-removal-area");
  const presetCheckboxes = getElement("preset-checkboxes");

  const syncCoverUploadVisibility = () => {
    coverUploadArea.hidden = !replaceCoverCheckbox.checked;
  };

  const syncStringRemovalVisibility = () => {
    stringRemovalArea.hidden = !removeStringsCheckbox.checked;
  };

  replaceCoverCheckbox.addEventListener("change", syncCoverUploadVisibility);
  removeStringsCheckbox.addEventListener("change", syncStringRemovalVisibility);

  presetCheckboxes.textContent = "";

  for (const preset of PRESETS) {
    const label = document.createElement("label");
    const input = document.createElement("input");

    input.type = "checkbox";
    input.value = preset.id;

    label.append(input, ` ${preset.label}`);
    presetCheckboxes.appendChild(label);
  }

  syncCoverUploadVisibility();
  syncStringRemovalVisibility();
}

export function getOptions() {
  const presetIds = Array.from(
    document.querySelectorAll("#preset-checkboxes input[type='checkbox']:checked"),
  ).map((input) => input.value);

  const customStrings = getElement("custom-strings")
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const coverFile = getElement("cover-input").files?.[0] ?? null;

  return {
    reorder: getElement("opt-reorder").checked,
    validate: getElement("opt-validate").checked,
    rebuildToc: getElement("opt-rebuild-toc").checked,
    split: getElement("opt-split").checked,
    merge: getElement("opt-merge").checked,
    replaceCover: getElement("opt-replace-cover").checked,
    coverFile,
    removeStrings: getElement("opt-remove-strings").checked,
    regexMode: getElement("opt-regex-mode").checked,
    customStrings,
    presetIds,
  };
}
