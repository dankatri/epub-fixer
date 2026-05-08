function getElement(id) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }

  return element;
}

export function initDropzone(onFileSelected) {
  if (typeof onFileSelected !== "function") {
    throw new Error("initDropzone requires an onFileSelected callback");
  }

  const dropzone = getElement("dropzone");
  const fileInput = getElement("file-input");
  const openFileButton = getElement("open-file-btn");
  const fileInfo = getElement("file-info");
  const fileName = getElement("file-name");
  const clearFileButton = getElement("clear-file-btn");

  const resetUI = () => {
    fileInput.value = "";
    fileName.textContent = "";
    fileInfo.hidden = true;
    dropzone.hidden = false;
    dropzone.classList.remove("dragover");
  };

  const setSelectedFile = (file) => {
    if (!file) {
      return;
    }

    onFileSelected(file);
    fileName.textContent = file.name;
    fileInfo.hidden = false;
    dropzone.hidden = true;
  };

  openFileButton.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0] ?? null;
    setSelectedFile(file);
  });

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");

    const file = event.dataTransfer?.files?.[0] ?? null;
    setSelectedFile(file);
  });

  clearFileButton.addEventListener("click", () => {
    resetUI();
    onFileSelected(null);
  });

  resetUI();
}
