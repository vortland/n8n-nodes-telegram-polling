import assert from 'node:assert/strict';
import test from 'node:test';

import type { ITriggerFunctions } from 'n8n-core';
import type { ApiResponse, Update } from 'typegram';

import {
	buildGetUpdatesBody,
	DEFAULT_TELEGRAM_BASE_URL,
	isIgnorableTelegram409,
	normalizeAllowedUpdates,
	normalizeBaseUrl,
	pollOnce,
	runPollingLoop,
	TelegramPollingTrigger,
} from '../nodes/TelegramPollingTrigger.node';

const makeUpdate = (update_id: number, partial: Record<string, unknown>): Update =>
	({ update_id, ...partial } as unknown as Update);

const okResponse = (updates: Update[]): ApiResponse<Update[]> =>
	({ ok: true, result: updates } as unknown as ApiResponse<Update[]>);

const notOkResponse = (): ApiResponse<Update[]> =>
	({ ok: false } as unknown as ApiResponse<Update[]>);

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
};

const rejectOnAbort = (signal: AbortSignal, reject: (reason: unknown) => void, reason: unknown) => {
	const maybeSignal = signal as unknown as {
		aborted?: boolean;
		onabort?: null | (() => void);
		addEventListener?: (type: string, listener: () => void) => void;
	};

	if (maybeSignal.aborted) {
		reject(reason);
		return;
	}

	if (typeof maybeSignal.addEventListener === 'function') {
		maybeSignal.addEventListener('abort', () => reject(reason));
		return;
	}

	maybeSignal.onabort = () => reject(reason);
};

test('normalizeAllowedUpdates returns empty array when * is included', () => {
	assert.deepEqual(normalizeAllowedUpdates(['*', 'message']), []);
});

test('normalizeAllowedUpdates keeps explicit update list when * is not included', () => {
	assert.deepEqual(normalizeAllowedUpdates(['message', 'callback_query']), [
		'message',
		'callback_query',
	]);
});

test('buildGetUpdatesBody produces allowed_updates field', () => {
	assert.deepEqual(
		buildGetUpdatesBody({ offset: 5, limit: 10, timeout: 60, allowedUpdates: ['message'] }),
		{ offset: 5, limit: 10, timeout: 60, allowed_updates: ['message'] },
	);
});

test('pollOnce returns empty result when response is not ok', async () => {
	let called = 0;
	const getUpdates = async ({ body }: { body: unknown; signal: AbortSignal }) => {
		called++;
		assert.deepEqual(body, { offset: 0, limit: 1, timeout: 0, allowed_updates: ['message'] });
		return notOkResponse();
	};

	const abortController = new AbortController();
	const result = await pollOnce({
		getUpdates,
		offset: 0,
		limit: 1,
		timeout: 0,
		allowedUpdates: ['message'],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
	});

	assert.equal(called, 1);
	assert.equal(result.nextOffset, 0);
	assert.deepEqual(result.updatesToEmit, []);
});

test('pollOnce advances offset to last_update_id + 1 and emits one item per update', async () => {
	const updates = [
		makeUpdate(10, { message: { chat: { id: 1 }, from: { id: 2 } } }),
		makeUpdate(11, { message: { chat: { id: 1 }, from: { id: 2 } } }),
	];

	const getUpdates = async () => okResponse(updates);
	const abortController = new AbortController();

	const result = await pollOnce({
		getUpdates,
		offset: 0,
		limit: 50,
		timeout: 60,
		allowedUpdates: [],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
	});

	assert.equal(result.nextOffset, 12);
	assert.equal(result.updatesToEmit.length, 2);
});

test('pollOnce keeps offset and emits nothing when Telegram returns empty updates', async () => {
	const getUpdates = async () => okResponse([]);
	const abortController = new AbortController();

	const result = await pollOnce({
		getUpdates,
		offset: 5,
		limit: 50,
		timeout: 60,
		allowedUpdates: [],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
	});

	assert.equal(result.nextOffset, 5);
	assert.deepEqual(result.updatesToEmit, []);
});

test('pollOnce filters by allowedUpdates when explicit list is provided', async () => {
	const updates = [
		makeUpdate(1, { message: { chat: { id: 1 }, from: { id: 2 } } }),
		makeUpdate(2, { callback_query: { from: { id: 2 }, message: { chat: { id: 1 } } } }),
	];

	const getUpdates = async () => okResponse(updates);
	const abortController = new AbortController();

	const result = await pollOnce({
		getUpdates,
		offset: 0,
		limit: 50,
		timeout: 60,
		allowedUpdates: ['message'],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
	});

	assert.equal(result.updatesToEmit.length, 1);
	assert.ok('message' in result.updatesToEmit[0]);
});

test('pollOnce does not filter by allowedUpdates when list is empty (e.g. *)', async () => {
	const updates = [
		makeUpdate(1, { message: { chat: { id: 1 }, from: { id: 2 } } }),
		makeUpdate(2, { callback_query: { from: { id: 2 }, message: { chat: { id: 1 } } } }),
	];

	const getUpdates = async ({
		body,
	}: {
		body: { allowed_updates: string[] };
		signal: AbortSignal;
	}) => {
		assert.deepEqual(body.allowed_updates, []);
		return okResponse(updates);
	};
	const abortController = new AbortController();

	const result = await pollOnce({
		getUpdates,
		offset: 0,
		limit: 50,
		timeout: 60,
		allowedUpdates: [],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
	});

	assert.equal(result.updatesToEmit.length, 2);
});

test('pollOnce filters by chat/user restrictions when configured', async () => {
	const updates = [
		makeUpdate(1, { message: { chat: { id: 1 }, from: { id: 2 } } }),
		makeUpdate(2, { message: { chat: { id: 999 }, from: { id: 2 } } }),
		makeUpdate(3, { message: { chat: { id: 1 }, from: { id: 555 } } }),
	];

	const getUpdates = async () => okResponse(updates);
	const abortController = new AbortController();

	const result = await pollOnce({
		getUpdates,
		offset: 0,
		limit: 50,
		timeout: 60,
		allowedUpdates: [],
		restrictChatIds: new Set(['1']),
		restrictUserIds: new Set(['2']),
		signal: abortController.signal,
	});

	assert.equal(result.updatesToEmit.length, 1);
});

test('runPollingLoop emits updates and stops after maxIterations', async () => {
	const updates = [makeUpdate(1, { message: { chat: { id: 1 }, from: { id: 2 } } })];

	let calls = 0;
	const getUpdates = async () => {
		calls++;
		return okResponse(updates);
	};

	const emitted: Update[][] = [];
	const abortController = new AbortController();
	let polling = true;

	await runPollingLoop({
		getUpdates,
		emit: (u) => emitted.push(u),
		limit: 50,
		timeout: 60,
		allowedUpdates: [],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
		isPolling: () => polling,
		maxIterations: 1,
	});

	assert.equal(calls, 1);
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].length, 1);
	assert.ok('message' in emitted[0][0]);
});

test('runPollingLoop does not emit when pollOnce yields no updates', async () => {
	let calls = 0;
	const getUpdates = async () => {
		calls++;
		return okResponse([]);
	};

	const emitted: Update[][] = [];
	const abortController = new AbortController();
	let polling = true;

	await runPollingLoop({
		getUpdates,
		emit: (u) => emitted.push(u),
		limit: 1,
		timeout: 0,
		allowedUpdates: [],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
		isPolling: () => polling,
		maxIterations: 1,
	});

	assert.equal(calls, 1);
	assert.equal(emitted.length, 0);
});

test('runPollingLoop ignores 409 error when stopping', async () => {
	const abortController = new AbortController();
	let polling = true;

	const getUpdates = async () => {
		polling = false;
		throw { response: { status: 409 } };
	};

	await runPollingLoop({
		getUpdates,
		emit: () => undefined,
		limit: 1,
		timeout: 0,
		allowedUpdates: [],
		restrictChatIds: new Set(),
		restrictUserIds: new Set(),
		signal: abortController.signal,
		isPolling: () => polling,
		maxIterations: 1,
	});
});

test('runPollingLoop rethrows 409 error when still polling', async () => {
	const abortController = new AbortController();
	let polling = true;

	const getUpdates = async () => {
		throw { response: { status: 409 } };
	};

	await assert.rejects(
		runPollingLoop({
			getUpdates,
			emit: () => undefined,
			limit: 1,
			timeout: 0,
			allowedUpdates: [],
			restrictChatIds: new Set(),
			restrictUserIds: new Set(),
			signal: abortController.signal,
			isPolling: () => polling,
			maxIterations: 1,
		}),
	);
});

test('isIgnorableTelegram409 returns false for non-object errors', () => {
	assert.equal(isIgnorableTelegram409(undefined, false), false);
});

test('isIgnorableTelegram409 returns false when response/status are missing', () => {
	assert.equal(isIgnorableTelegram409({}, false), false);
	assert.equal(isIgnorableTelegram409({ response: null }, false), false);
	assert.equal(isIgnorableTelegram409({ response: {} }, false), false);
});

test('isIgnorableTelegram409 returns false when status is not a number', () => {
	assert.equal(isIgnorableTelegram409({ response: { status: '409' } }, false), false);
});

test('trigger emits one item per update and uses normalized allowed_updates', async () => {
	const node = new TelegramPollingTrigger();

	let requestCalls = 0;
	const emitted = deferred<unknown>();

	const fakeThis = {
		getCredentials: async () => ({ accessToken: 'TOKEN' }),
		getNodeParameter: (name: string) => {
			switch (name) {
				case 'limit':
					return 50;
				case 'timeout':
					return 0;
				case 'updates':
					return ['*'];
				case 'restrictChatIds':
					return '';
				case 'restrictUserIds':
					return '';
				default:
					throw new Error(`Unexpected parameter: ${name}`);
			}
		},
		helpers: {
			request: async (options: {
				method: string;
				uri: string;
				body: { allowed_updates: string[] };
				json: boolean;
				timeout: number;
				signal: AbortSignal;
			}) => {
				requestCalls++;
				assert.equal(options.method, 'post');
				assert.equal(options.uri, 'https://api.telegram.org/botTOKEN/getUpdates');
				assert.deepEqual(options.body.allowed_updates, []);

				if (requestCalls === 1) {
					return okResponse([
						makeUpdate(1, { message: { chat: { id: 1 }, from: { id: 2 } } }),
						makeUpdate(2, { message: { chat: { id: 1 }, from: { id: 2 } } }),
					]);
				}

				return await new Promise((_resolve, reject) => {
					rejectOnAbort(options.signal, reject, { response: { status: 409 } });
				});
			},
		},
		emit: (data: unknown) => {
			emitted.resolve(data);
		},
	} as unknown as ITriggerFunctions;

	const { closeFunction } = await node.trigger.call(fakeThis);
	if (!closeFunction) {
		throw new Error('Expected closeFunction to be defined');
	}
	await emitted.promise;
	await closeFunction();

	assert.ok(requestCalls >= 1);
	await new Promise((resolve) => setImmediate(resolve));
});

test('trigger passes explicit allowed_updates when configured', async () => {
	const node = new TelegramPollingTrigger();

	let requestCalls = 0;
	let sawAllowedUpdates: string[] | null = null;

	const fakeThis = {
		getCredentials: async () => ({ accessToken: 'TOKEN' }),
		getNodeParameter: (name: string) => {
			switch (name) {
				case 'limit':
					return 50;
				case 'timeout':
					return 0;
				case 'updates':
					return ['message'];
				case 'restrictChatIds':
					return '1';
				case 'restrictUserIds':
					return '2';
				default:
					throw new Error(`Unexpected parameter: ${name}`);
			}
		},
		helpers: {
			request: async (options: { body: { allowed_updates: string[] }; signal: AbortSignal }) => {
				requestCalls++;
				sawAllowedUpdates = options.body.allowed_updates;

				if (requestCalls === 1) {
					return okResponse([]);
				}

				return await new Promise((_resolve, reject) => {
					rejectOnAbort(options.signal, reject, { response: { status: 409 } });
				});
			},
		},
		emit: () => undefined,
	} as unknown as ITriggerFunctions;

	const { closeFunction } = await node.trigger.call(fakeThis);
	if (!closeFunction) {
		throw new Error('Expected closeFunction to be defined');
	}
	await closeFunction();

	assert.deepEqual(sawAllowedUpdates, ['message']);
	await new Promise((resolve) => setImmediate(resolve));
});

test('normalizeBaseUrl falls back to the official endpoint', () => {
	assert.equal(normalizeBaseUrl(undefined), DEFAULT_TELEGRAM_BASE_URL);
	assert.equal(normalizeBaseUrl(''), DEFAULT_TELEGRAM_BASE_URL);
	assert.equal(normalizeBaseUrl('   '), DEFAULT_TELEGRAM_BASE_URL);
});

test('normalizeBaseUrl trims whitespace and trailing slashes', () => {
	assert.equal(normalizeBaseUrl('https://tg.example.com'), 'https://tg.example.com');
	assert.equal(normalizeBaseUrl('https://tg.example.com/'), 'https://tg.example.com');
	assert.equal(normalizeBaseUrl('https://tg.example.com///'), 'https://tg.example.com');
	assert.equal(normalizeBaseUrl('  https://tg.example.com/  '), 'https://tg.example.com');
	assert.equal(normalizeBaseUrl('https://tg.example.com/proxy/'), 'https://tg.example.com/proxy');
});

test('trigger targets the custom base URL from the credential', async () => {
	const node = new TelegramPollingTrigger();

	let requestCalls = 0;
	let sawUri: string | null = null;

	const fakeThis = {
		getCredentials: async () => ({
			accessToken: 'TOKEN',
			baseUrl: 'https://tg-proxy.example.com/',
		}),
		getNodeParameter: (name: string) => {
			switch (name) {
				case 'limit':
					return 50;
				case 'timeout':
					return 0;
				case 'updates':
					return ['*'];
				case 'restrictChatIds':
					return '';
				case 'restrictUserIds':
					return '';
				default:
					throw new Error(`Unexpected parameter: ${name}`);
			}
		},
		helpers: {
			request: async (options: { uri: string; signal: AbortSignal }) => {
				requestCalls++;
				sawUri = options.uri;

				if (requestCalls === 1) {
					return okResponse([]);
				}

				return await new Promise((_resolve, reject) => {
					rejectOnAbort(options.signal, reject, { response: { status: 409 } });
				});
			},
		},
		emit: () => undefined,
	} as unknown as ITriggerFunctions;

	const { closeFunction } = await node.trigger.call(fakeThis);
	if (!closeFunction) {
		throw new Error('Expected closeFunction to be defined');
	}
	await closeFunction();

	assert.equal(sawUri, 'https://tg-proxy.example.com/botTOKEN/getUpdates');
	await new Promise((resolve) => setImmediate(resolve));
});
