function getLogElement() {
  const logElement = document.getElementById("log");

  if (!logElement) {
    throw new Error("Missing required element: #log");
  }

  return logElement;
}

function formatTimestamp(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

export function clearLog() {
  getLogElement().textContent = "";
}

export function log(message, type = "info") {
  const allowedTypes = new Set(["info", "success", "warn", "error"]);
  const safeType = allowedTypes.has(type) ? type : "info";
  const entry = document.createElement("div");

  entry.className = `log-entry log-${safeType}`;
  entry.textContent = `[${formatTimestamp()}] ${String(message)}`;

  const logElement = getLogElement();
  logElement.appendChild(entry);
  logElement.scrollTop = logElement.scrollHeight;
}
