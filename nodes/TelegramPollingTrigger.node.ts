/* eslint-disable n8n-nodes-base/node-dirname-against-convention */
import { ITriggerFunctions } from 'n8n-core';
import { IDataObject, INodeType, INodeTypeDescription, ITriggerResponse } from 'n8n-workflow';
import { ApiResponse, Update } from 'typegram';
import { matchesRestrictions, parseIdList } from './telegramPollingFilters';

export type TelegramGetUpdatesBody = {
	offset: number;
	limit: number;
	timeout: number;
	allowed_updates: string[];
};

export type TelegramGetUpdatesFn = (args: {
	body: TelegramGetUpdatesBody;
	signal: AbortSignal;
}) => Promise<ApiResponse<Update[]>>;

export const DEFAULT_TELEGRAM_BASE_URL = 'https://api.telegram.org';

/**
 * Resolves the Telegram Bot API base URL from the credential, falling back to
 * the official endpoint. Trailing slashes are stripped so the path can be
 * appended directly.
 */
export function normalizeBaseUrl(baseUrl: string | undefined): string {
	const trimmed = (baseUrl ?? '').trim();

	if (trimmed === '') {
		return DEFAULT_TELEGRAM_BASE_URL;
	}

	return trimmed.replace(/\/+$/, '');
}

export function normalizeAllowedUpdates(allowedUpdates: string[]): string[] {
	return allowedUpdates.includes('*') ? [] : allowedUpdates;
}

export function buildGetUpdatesBody(args: {
	offset: number;
	limit: number;
	timeout: number;
	allowedUpdates: string[];
}): TelegramGetUpdatesBody {
	return {
		offset: args.offset,
		limit: args.limit,
		timeout: args.timeout,
		allowed_updates: args.allowedUpdates,
	};
}

export function computeNextOffset(currentOffset: number, updates: Update[]): number {
	if (updates.length === 0) {
		return currentOffset;
	}

	return updates[updates.length - 1].update_id + 1;
}

export function filterUpdatesForEmit(args: {
	updates: Update[];
	allowedUpdates: string[];
	restrictChatIds: Set<string>;
	restrictUserIds: Set<string>;
}): Update[] {
	let updates = args.updates;

	if (args.allowedUpdates.length > 0) {
		updates = updates.filter((update) =>
			Object.keys(update).some((key) => args.allowedUpdates.includes(key)),
		);
	}

	if (args.restrictChatIds.size > 0 || args.restrictUserIds.size > 0) {
		updates = updates.filter((update) =>
			matchesRestrictions(update, args.restrictChatIds, args.restrictUserIds),
		);
	}

	return updates;
}

function getErrorResponseStatusCode(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}

	if (!('response' in error)) {
		return undefined;
	}

	const response = (error as { response?: unknown }).response;
	if (typeof response !== 'object' || response === null) {
		return undefined;
	}

	if (!('status' in response)) {
		return undefined;
	}

	const status = (response as { status?: unknown }).status;
	return typeof status === 'number' ? status : undefined;
}

export function isIgnorableTelegram409(error: unknown, isPolling: boolean): boolean {
	return !isPolling && getErrorResponseStatusCode(error) === 409;
}

export async function pollOnce(args: {
	getUpdates: TelegramGetUpdatesFn;
	offset: number;
	limit: number;
	timeout: number;
	allowedUpdates: string[];
	restrictChatIds: Set<string>;
	restrictUserIds: Set<string>;
	signal: AbortSignal;
}): Promise<{
	nextOffset: number;
	updatesToEmit: Update[];
	requestedBody: TelegramGetUpdatesBody;
}> {
	const requestedBody = buildGetUpdatesBody({
		offset: args.offset,
		limit: args.limit,
		timeout: args.timeout,
		allowedUpdates: args.allowedUpdates,
	});

	const response = await args.getUpdates({ body: requestedBody, signal: args.signal });

	if (!response.ok || !response.result) {
		return {
			nextOffset: args.offset,
			updatesToEmit: [],
			requestedBody,
		};
	}

	const updates = response.result;
	const nextOffset = computeNextOffset(args.offset, updates);

	const updatesToEmit =
		updates.length === 0
			? []
			: filterUpdatesForEmit({
					updates,
					allowedUpdates: args.allowedUpdates,
					restrictChatIds: args.restrictChatIds,
					restrictUserIds: args.restrictUserIds,
			  });

	return {
		nextOffset,
		updatesToEmit,
		requestedBody,
	};
}

export async function runPollingLoop(args: {
	getUpdates: TelegramGetUpdatesFn;
	emit: (updates: Update[]) => void;
	limit: number;
	timeout: number;
	allowedUpdates: string[];
	restrictChatIds: Set<string>;
	restrictUserIds: Set<string>;
	signal: AbortSignal;
	isPolling: () => boolean;
	maxIterations?: number;
}): Promise<void> {
	let offset = 0;
	let iterations = 0;

	while (args.isPolling()) {
		if (args.maxIterations !== undefined && iterations >= args.maxIterations) {
			return;
		}

		iterations++;

		try {
			const result = await pollOnce({
				getUpdates: args.getUpdates,
				offset,
				limit: args.limit,
				timeout: args.timeout,
				allowedUpdates: args.allowedUpdates,
				restrictChatIds: args.restrictChatIds,
				restrictUserIds: args.restrictUserIds,
				signal: args.signal,
			});

			offset = result.nextOffset;
			if (result.updatesToEmit.length > 0) {
				args.emit(result.updatesToEmit);
			}
		} catch (error) {
			if (isIgnorableTelegram409(error, args.isPolling())) {
				console.debug('error 409, ignoring because execution is on final cleanup...');
				continue;
			}

			throw error;
		}
	}
}

export class TelegramPollingTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Telegram Trigger (long polling) Trigger',
		name: 'telegramPollingTrigger',
		icon: 'file:telegram.svg',
		group: ['trigger'],
		version: 1,
		description: 'Starts the workflow on a Telegram update via long polling',
		defaults: {
			name: 'Telegram Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'telegramApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Updates',
				name: 'updates',
				type: 'multiOptions',
				options: [
					{
						name: '*',
						value: '*',
						description: 'All updates',
					},
					{
						name: 'Bot Chat Member Updated',
						value: 'my_chat_member',
						description:
							"Trigger on the bot's chat member status was updated in a chat. For private chats, this update is received only when the bot is blocked or unblocked by the user.",
					},
					{
						name: 'Callback Query',
						value: 'callback_query',
						description: 'Trigger on new incoming callback query',
					},
					{
						name: 'Channel Post',
						value: 'channel_post',
						description:
							'Trigger on new incoming channel post of any kind — text, photo, sticker, etc',
					},
					{
						name: 'Chat Join Request',
						value: 'chat_join_request',
						description:
							'Trigger on a request to join the chat has been sent. The bot must have the can_invite_users administrator right in the chat to receive these updates.',
					},
					{
						name: 'Chosen Inline Result',
						value: 'chosen_inline_result',
						description:
							'Trigger on the result of an inline query that was chosen by a user and sent to their chat partner',
					},
					{
						name: 'Edited Channel Post',
						value: 'edited_channel_post',
						description:
							'Trigger on new version of a channel post that is known to the bot and was edited',
					},
					{
						name: 'Edited Message',
						value: 'edited_message',
						description:
							'Trigger on new version of a channel post that is known to the bot and was edited',
					},
					{
						name: 'Inline Query',
						value: 'inline_query',
						description: 'Trigger on new incoming inline query',
					},
					{
						name: 'Message',
						value: 'message',
						description: 'Trigger on new incoming message of any kind — text, photo, sticker, etc',
					},
					{
						name: 'Poll',
						value: 'poll',
						description:
							'Trigger on new poll state. Bots receive only updates about stopped polls and polls, which are sent by the bot.',
					},
					{
						name: 'Poll Answer',
						value: 'poll_answer',
						description:
							'Trigger on new poll answer. Bots receive only updates about stopped polls and polls, which are sent by the bot.',
					},
					{
						name: 'Pre-Checkout Query',
						value: 'pre_checkout_query',
						description:
							'Trigger on new incoming pre-checkout query. Contains full information about checkout.',
					},
					{
						name: 'Shipping Query',
						value: 'shipping_query',
						description:
							'Trigger on new incoming shipping query. Only for invoices with flexible price.',
					},
					{
						name: 'User Chat Member Updated',
						value: 'chat_member',
						description:
							'Trigger on the user chat member status was updated in a chat. The bot must be an administrator in the chat and must explicitly specify “chat_member” in the list of allowed_updates to receive these updates.',
					},
				],
				required: true,
				default: [],
				description: 'The update types to listen to',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 50,
				// eslint-disable-next-line n8n-nodes-base/node-param-description-wrong-for-limit
				description: 'Limit the number of messages to be polled',
			},
			{
				displayName: 'Timeout',
				name: 'timeout',
				type: 'number',
				typeOptions: {
					minValue: 0,
				},
				default: 60,
				description: 'Timeout (in seconds) for the polling request',
			},
			{
				displayName: 'Restrict to Chat IDs',
				name: 'restrictChatIds',
				type: 'string',
				default: '',
				description: 'Only allow updates from these chat IDs (comma- or space-separated)',
			},
			{
				displayName: 'Restrict to User IDs',
				name: 'restrictUserIds',
				type: 'string',
				default: '',
				description: 'Only allow updates from these user IDs (comma- or space-separated)',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('telegramApi');
		const baseUrl = normalizeBaseUrl(credentials.baseUrl as string | undefined);

		const limit = this.getNodeParameter('limit') as number;
		const timeout = this.getNodeParameter('timeout') as number;
		const restrictChatIds = parseIdList(this.getNodeParameter('restrictChatIds') as string);
		const restrictUserIds = parseIdList(this.getNodeParameter('restrictUserIds') as string);

		const allowedUpdates = normalizeAllowedUpdates(this.getNodeParameter('updates') as string[]);

		let isPolling = true;
		const abortController = new AbortController();

		const getUpdates: TelegramGetUpdatesFn = async ({ body, signal }) =>
			(await this.helpers.request({
				method: 'post',
				uri: `${baseUrl}/bot${credentials.accessToken}/getUpdates`,
				body,
				json: true,
				timeout: 0,
				// dows this work? maybe it isn't passed to Axtios, there's a trnslation step made by N8N in the middle
				signal,
			})) as ApiResponse<Update[]>;

		const emitUpdates = (updates: Update[]) => {
			this.emit([updates.map((update) => ({ json: update as unknown as IDataObject }))]);
		};

		runPollingLoop({
			getUpdates,
			emit: emitUpdates,
			limit,
			timeout,
			allowedUpdates,
			restrictChatIds,
			restrictUserIds,
			signal: abortController.signal,
			isPolling: () => isPolling,
		});

		const closeFunction = async () => {
			isPolling = false;
			abortController.abort();
		};

		return {
			closeFunction,
		};
	}
}
