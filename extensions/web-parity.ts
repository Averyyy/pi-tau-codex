import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type AuthStorage = ExtensionContext["modelRegistry"]["authStorage"];
type LoginMethod = "oauth" | "api_key";
type LoginMethodArgument = "oauth" | "api-key";

export type WebParityCommandName = "login" | "logout" | "quit";

export interface WebParityResult {
	readonly command: WebParityCommandName;
	readonly status: "ok" | "shutdown";
	readonly provider?: string;
	readonly authType?: LoginMethod;
}

export type WebParityCommandHandler = (
	args: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
) => Promise<WebParityResult | undefined>;

export interface WebParityCommand {
	readonly name: WebParityCommandName;
	readonly tuiName: `tau-${WebParityCommandName}`;
	readonly description: string;
	readonly handler: WebParityCommandHandler;
}

interface LoginChoice {
	readonly providerId: string;
	readonly method: LoginMethod;
	readonly label: string;
}

interface ParsedLoginArgs {
	readonly providerId?: string;
	readonly method?: LoginMethod;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authStorageError(action: string, error: Error): Error {
	return new Error(
		`${action} cannot continue because auth.json is malformed or unavailable: ${error.message}. ` +
		"Fix auth.json manually; Tau will not repair it.",
	);
}

function validateStoredCredentials(authStorage: AuthStorage): void {
	const data: unknown = authStorage.getAll();
	if (!isRecord(data)) {
		throw new Error("auth.json must contain a JSON object. Fix auth.json manually; Tau will not repair it.");
	}

	for (const [providerId, value] of Object.entries(data)) {
		if (!isRecord(value) || (value.type !== "api_key" && value.type !== "oauth")) {
			throw new Error(
				`auth.json contains invalid credentials for provider "${providerId}". ` +
				"Fix auth.json manually; Tau will not repair it.",
			);
		}

		if (value.type === "api_key" && typeof value.key !== "string") {
			throw new Error(
				`auth.json contains an invalid API key entry for provider "${providerId}". ` +
				"Fix auth.json manually; Tau will not repair it.",
			);
		}

		if (
			value.type === "oauth" &&
			(typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number")
		) {
			throw new Error(
				`auth.json contains an invalid OAuth entry for provider "${providerId}". ` +
				"Fix auth.json manually; Tau will not repair it.",
			);
		}
	}
}

function ensureAuthStorageHealthy(authStorage: AuthStorage, action: string): void {
	authStorage.reload();
	const errors = authStorage.drainErrors();
	const firstError = errors[0];
	if (firstError) {
		throw authStorageError(action, firstError);
	}
	validateStoredCredentials(authStorage);
}

function ensureAuthStorageWriteSucceeded(authStorage: AuthStorage, action: string): void {
	const firstError = authStorage.drainErrors()[0];
	if (firstError) {
		throw authStorageError(action, firstError);
	}
}

function parseLoginArgs(args: string): ParsedLoginArgs {
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	if (tokens.length > 2) {
		throw new Error("Usage: /tau-login [provider] [oauth|api-key]");
	}

	const methodArgument = tokens[1] as LoginMethodArgument | undefined;
	if (methodArgument && methodArgument !== "oauth" && methodArgument !== "api-key") {
		throw new Error("Usage: /tau-login [provider] [oauth|api-key]");
	}

	return {
		providerId: tokens[0],
		method: methodArgument === "api-key" ? "api_key" : methodArgument,
	};
}

function providerDisplayName(ctx: ExtensionContext, providerId: string): string {
	return ctx.modelRegistry.getProviderDisplayName(providerId);
}

function providerLabel(ctx: ExtensionContext, providerId: string, method: LoginMethod): string {
	const methodLabel = method === "oauth" ? "OAuth" : "API key";
	return `${providerDisplayName(ctx, providerId)} (${methodLabel}, ${providerId})`;
}

function getProviderSets(ctx: ExtensionContext): {
	oauth: ReadonlySet<string>;
	apiKey: ReadonlySet<string>;
} {
	return {
		oauth: new Set(ctx.modelRegistry.authStorage.getOAuthProviders().map((provider) => provider.id)),
		apiKey: new Set(ctx.modelRegistry.getAll().map((model) => model.provider)),
	};
}

function getLoginChoices(ctx: ExtensionContext): LoginChoice[] {
	const { oauth, apiKey } = getProviderSets(ctx);
	const providerIds = new Set([...oauth, ...apiKey]);
	const choices: LoginChoice[] = [];

	for (const providerId of providerIds) {
		if (oauth.has(providerId)) {
			choices.push({
				providerId,
				method: "oauth",
				label: providerLabel(ctx, providerId, "oauth"),
			});
		}
		if (apiKey.has(providerId)) {
			choices.push({
				providerId,
				method: "api_key",
				label: providerLabel(ctx, providerId, "api_key"),
			});
		}
	}

	return choices.sort((left, right) => left.label.localeCompare(right.label));
}

async function resolveLoginChoice(args: string, ctx: ExtensionContext): Promise<LoginChoice> {
	const parsed = parseLoginArgs(args);
	const { oauth, apiKey } = getProviderSets(ctx);

	if (!parsed.providerId) {
		const choices = getLoginChoices(ctx);
		if (choices.length === 0) {
			throw new Error("No login providers are available.");
		}

		const selectedLabel = await ctx.ui.select(
			"Select a provider to log in:",
			choices.map((choice) => choice.label),
			{ signal: ctx.signal },
		);
		if (selectedLabel === undefined) {
			throw new Error("Login cancelled.");
		}

		const selectedChoice = choices.find((choice) => choice.label === selectedLabel);
		if (!selectedChoice) {
			throw new Error("The selected login provider is no longer available.");
		}
		return selectedChoice;
	}

	const providerId = parsed.providerId;
	const knownProvider = oauth.has(providerId) || apiKey.has(providerId);
	if (!knownProvider) {
		throw new Error(`Unknown login provider: ${providerId}`);
	}

	if (parsed.method === "oauth") {
		if (!oauth.has(providerId)) {
			throw new Error(`Provider "${providerId}" does not support OAuth login.`);
		}
		return { providerId, method: "oauth", label: providerLabel(ctx, providerId, "oauth") };
	}

	if (parsed.method === "api_key") {
		if (!apiKey.has(providerId)) {
			throw new Error(`Provider "${providerId}" does not expose API-key login.`);
		}
		return { providerId, method: "api_key", label: providerLabel(ctx, providerId, "api_key") };
	}

	if (oauth.has(providerId)) {
		return { providerId, method: "oauth", label: providerLabel(ctx, providerId, "oauth") };
	}
	return { providerId, method: "api_key", label: providerLabel(ctx, providerId, "api_key") };
}

async function loginWithApiKey(choice: LoginChoice, ctx: ExtensionContext): Promise<void> {
	const apiKey = await ctx.ui.input(
		`Enter API key for ${providerDisplayName(ctx, choice.providerId)}:`,
		undefined,
		{ signal: ctx.signal },
	);
	if (apiKey === undefined) {
		throw new Error("Login cancelled.");
	}

	const trimmedApiKey = apiKey.trim();
	if (!trimmedApiKey) {
		throw new Error("API key cannot be empty.");
	}

	const authStorage = ctx.modelRegistry.authStorage;
	authStorage.set(choice.providerId, { type: "api_key", key: trimmedApiKey });
	ensureAuthStorageWriteSucceeded(authStorage, "Saving the API key");
}

async function loginWithOAuth(choice: LoginChoice, ctx: ExtensionContext): Promise<void> {
	const authStorage = ctx.modelRegistry.authStorage;
	const loginController = new AbortController();
	const parentSignal = ctx.signal;
	const abortFromParent = () => loginController.abort();

	if (parentSignal) {
		if (parentSignal.aborted) {
			loginController.abort();
		} else {
			parentSignal.addEventListener("abort", abortFromParent, { once: true });
		}
	}

	try {
		await authStorage.login(choice.providerId, {
			onAuth: ({ url, instructions }) => {
				const message = instructions ? `Open ${url}\n${instructions}` : `Open ${url} to continue login.`;
				ctx.ui.notify(message, "info");
			},
			onDeviceCode: ({ verificationUri, userCode }) => {
				ctx.ui.notify(`Open ${verificationUri} and enter code ${userCode}.`, "info");
			},
			onPrompt: async ({ message, placeholder, allowEmpty }) => {
				const value = await ctx.ui.input(message, placeholder, { signal: loginController.signal });
				if (value === undefined) {
					throw new Error("Login cancelled.");
				}
				if (!allowEmpty && value.length === 0) {
					throw new Error("Login input cannot be empty.");
				}
				return value;
			},
			onProgress: (message) => {
				ctx.ui.notify(message, "info");
			},
			onManualCodeInput: async () => {
				const value = await ctx.ui.input(
					"Paste the authorization code or redirect URL:",
					undefined,
					{ signal: loginController.signal },
				);
				if (value === undefined) {
					throw new Error("Login cancelled.");
				}
				if (!value.trim()) {
					throw new Error("Authorization code cannot be empty.");
				}
				return value;
			},
			onSelect: async (prompt) => {
				const selectedLabel = await ctx.ui.select(
					prompt.message,
					prompt.options.map((option) => option.label),
					{ signal: loginController.signal },
				);
				if (selectedLabel === undefined) {
					throw new Error("Login cancelled.");
				}

				const selectedOption = prompt.options.find((option) => option.label === selectedLabel);
				if (!selectedOption) {
					throw new Error("The selected OAuth option is no longer available.");
				}
				return selectedOption.id;
			},
			signal: loginController.signal,
		});
		ensureAuthStorageWriteSucceeded(authStorage, "Saving OAuth credentials");
	} finally {
		loginController.abort();
		parentSignal?.removeEventListener("abort", abortFromParent);
	}
}

async function handleLogin(args: string, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<WebParityResult> {
	const authStorage = ctx.modelRegistry.authStorage;
	ensureAuthStorageHealthy(authStorage, "Login");

	const choice = await resolveLoginChoice(args, ctx);
	if (choice.method === "oauth") {
		await loginWithOAuth(choice, ctx);
	} else {
		await loginWithApiKey(choice, ctx);
	}

	ctx.modelRegistry.refresh();
	ctx.ui.notify(
		choice.method === "oauth"
			? `Logged in to ${providerDisplayName(ctx, choice.providerId)}.`
			: `Saved API key for ${providerDisplayName(ctx, choice.providerId)}.`,
		"info",
	);

	return {
		command: "login",
		status: "ok",
		provider: choice.providerId,
		authType: choice.method,
	};
}

function parseLogoutProvider(args: string): string | undefined {
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	if (tokens.length > 1) {
		throw new Error("Usage: /tau-logout [provider]");
	}
	return tokens[0];
}

async function resolveLogoutProvider(args: string, ctx: ExtensionContext): Promise<string> {
	const requestedProvider = parseLogoutProvider(args);
	const authStorage = ctx.modelRegistry.authStorage;
	if (requestedProvider) {
		const knownProviders = new Set([
			...ctx.modelRegistry.getAll().map((model) => model.provider),
			...authStorage.getOAuthProviders().map((provider) => provider.id),
		]);
		if (!knownProviders.has(requestedProvider)) {
			throw new Error(`Unknown logout provider: ${requestedProvider}`);
		}
		if (!authStorage.has(requestedProvider)) {
			throw new Error(`No stored credentials for provider: ${requestedProvider}`);
		}
		return requestedProvider;
	}

	const providers = authStorage
		.list()
		.filter((providerId) => authStorage.has(providerId))
		.sort((left, right) => {
			const leftLabel = `${providerDisplayName(ctx, left)} (${left})`;
			const rightLabel = `${providerDisplayName(ctx, right)} (${right})`;
			return leftLabel.localeCompare(rightLabel);
		});
	if (providers.length === 0) {
		throw new Error("No stored credentials to remove.");
	}

	const labels = providers.map((providerId) => `${providerDisplayName(ctx, providerId)} (${providerId})`);
	const selectedLabel = await ctx.ui.select("Select a provider to log out:", labels, { signal: ctx.signal });
	if (selectedLabel === undefined) {
		throw new Error("Logout cancelled.");
	}

	const selectedIndex = labels.indexOf(selectedLabel);
	if (selectedIndex < 0) {
		throw new Error("The selected logout provider is no longer available.");
	}
	return providers[selectedIndex];
}

async function handleLogout(args: string, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<WebParityResult> {
	const authStorage = ctx.modelRegistry.authStorage;
	ensureAuthStorageHealthy(authStorage, "Logout");

	const providerId = await resolveLogoutProvider(args, ctx);
	const credential = authStorage.get(providerId);
	if (!credential) {
		throw new Error(`No stored credentials for provider: ${providerId}`);
	}

	authStorage.logout(providerId);
	ensureAuthStorageWriteSucceeded(authStorage, "Removing stored credentials");
	ctx.modelRegistry.refresh();
	ctx.ui.notify(`Removed stored credentials for ${providerDisplayName(ctx, providerId)}.`, "info");

	return {
		command: "logout",
		status: "ok",
		provider: providerId,
		authType: credential.type,
	};
}

async function handleQuit(args: string, ctx: ExtensionContext, _pi: ExtensionAPI): Promise<WebParityResult> {
	if (args.trim()) {
		throw new Error("Usage: /tau-quit");
	}
	// Let the mirror flush the command response before Pi exits.
	setImmediate(() => ctx.shutdown());
	return { command: "quit", status: "shutdown" };
}

const WEB_PARITY_COMMANDS = Object.freeze([
	{
		name: "login",
		tuiName: "tau-login",
		description: "Log in to a model provider without replacing Pi's built-in /login.",
		handler: handleLogin,
	},
	{
		name: "logout",
		tuiName: "tau-logout",
		description: "Remove stored provider credentials without replacing Pi's built-in /logout.",
		handler: handleLogout,
	},
	{
		name: "quit",
		tuiName: "tau-quit",
		description: "Shut down Pi from Tau without replacing Pi's built-in /quit.",
		handler: handleQuit,
	},
] satisfies readonly WebParityCommand[]);

const WEB_PARITY_COMMANDS_BY_NAME = new Map<WebParityCommandName, WebParityCommand>(
	WEB_PARITY_COMMANDS.map((command) => [command.name, command]),
);

export function getWebParityCommand(name: string): WebParityCommand | undefined {
	const normalizedName = name.trim().toLowerCase();
	const commandName = normalizedName.startsWith("/") ? normalizedName.slice(1) : normalizedName;
	const direct = WEB_PARITY_COMMANDS_BY_NAME.get(commandName as WebParityCommandName);
	return direct ?? WEB_PARITY_COMMANDS.find((command) => command.tuiName === commandName);
}

export function getWebParityCommands(): readonly WebParityCommand[] {
	return WEB_PARITY_COMMANDS;
}

export default function webParityExtension(pi: ExtensionAPI): void {
	for (const command of WEB_PARITY_COMMANDS) {
		pi.registerCommand(command.tuiName, {
			description: command.description,
			handler: async (args, ctx) => {
				await command.handler(args, ctx, pi);
			},
		});
	}
}
