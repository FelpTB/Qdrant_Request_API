/**
 * Logs estruturados para visibilidade em produção (Railway, Docker, etc.).
 * Formato: [ISO timestamp] [endpoint] level: message { ...details }
 */

function timestamp() {
  return new Date().toISOString();
}

function log(level, endpoint, message, details = null) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[${timestamp()}] [${endpoint}] ${level}: ${message}${payload}`);
}

export function logSuccess(endpoint, message, details = null) {
  log("SUCCESS", endpoint, message, details);
}

export function logError(endpoint, message, err, details = null) {
  const errDetail = {
    ...(details || {}),
    error_message: err?.message ?? String(err),
    error_code: err?.code,
    error_status: err?.status ?? err?.statusCode,
    error_data: err?.data,
    stack: err?.stack ? err.stack.split("\n").slice(0, 5).join(" | ") : undefined,
  };
  log("ERROR", endpoint, message, errDetail);
  if (err?.stack) {
    console.error(`[${timestamp()}] [${endpoint}] STACK:\n${err.stack}`);
  }
}
