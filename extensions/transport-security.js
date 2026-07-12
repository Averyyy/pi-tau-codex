const READ_ONLY_WS_COMMANDS = new Set([
  "get_auth",
  "get_about",
  "get_available_models",
  "get_commands",
  "get_enabled_models",
  "get_messages",
  "get_provider_accounts",
  "get_session_stats",
  "get_state",
  "extension_tui_resize",
  "mirror_sync_request",
]);

export function isWebSocketMutation(type) {
  return !READ_ONLY_WS_COMMANDS.has(type);
}

export function isHttpMutation(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "").toUpperCase());
}

export function isWebSocketCommandFrame(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.type === "string"
    && value.type.trim().length > 0;
}

export function createOneShotRelayPolicy(expectedToken, expectedCommand) {
  const command = expectedCommand === "prompt" || expectedCommand === "set_browser_draft"
    ? expectedCommand
    : null;
  let token = typeof expectedToken === "string" && expectedToken && command
    ? expectedToken
    : null;
  let commandUsed = false;

  return {
    consumeToken(candidate) {
      if (!token || candidate !== token) return false;
      token = null;
      return true;
    },
    acceptCommand(type) {
      if (commandUsed) return false;
      commandUsed = true;
      return type === command;
    },
  };
}

export function isAllowedOrigin(origin, host) {
  if (!origin) return true;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
      && parsed.host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

function normalizeHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  return unbracketed.split("%", 1)[0];
}

export function createAllowedHostnames(networkInterfaces, configuredHost) {
  const allowed = new Set(["localhost", "::1"]);
  for (const addresses of Object.values(networkInterfaces || {})) {
    for (const entry of addresses || []) {
      if (entry?.address) allowed.add(normalizeHostname(entry.address));
    }
  }
  const explicitHost = normalizeHostname(configuredHost);
  if (explicitHost && explicitHost !== "0.0.0.0" && explicitHost !== "::") {
    allowed.add(explicitHost);
  }
  return allowed;
}

export function isAllowedRequestHost(host, allowedHostnames) {
  if (typeof host !== "string" || !host || /[\s\/@?#]/.test(host)) return false;
  try {
    const hostname = normalizeHostname(new URL(`http://${host}`).hostname);
    return isLoopbackAddress(hostname) || allowedHostnames.has(hostname);
  } catch {
    return false;
  }
}

export function isAllowedRequestOrigin(origin, host, allowedHostnames) {
  return isAllowedRequestHost(host, allowedHostnames) && isAllowedOrigin(origin, host);
}

export function isLoopbackAddress(address) {
  const normalized = String(address || "").split("%", 1)[0].toLowerCase();
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const octets = ipv4.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function mutationAuthorizationFailure({
  isLoopback,
  authConfigured,
  authEnabled,
  basicAuthenticated,
  tokenMatches,
}) {
  if (!isLoopback && (!authConfigured || !authEnabled)) {
    return { status: 403, message: "Remote mutations require enabled Basic authentication" };
  }
  if (authEnabled && !basicAuthenticated) {
    return { status: 401, message: "Basic authentication is required" };
  }
  if (!tokenMatches) {
    return { status: 403, message: "A live connection mutation token is required" };
  }
  return null;
}
