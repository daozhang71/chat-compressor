import { getStringHash, debounce } from '../../../utils.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../../extensions.js';
import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    getCurrentChatId,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParamsExtended,
    generateRaw,
    chat_metadata,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { debounce_timeout } from '../../../constants.js';

const MODULE_NAME = 'chat_compressor';
const EXTENSION_PROMPT_TAG = 'chat_compressor_injection';

// Google AI Embedding API endpoint
const GOOGLE_EMBEDDING_API = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';

// Default settings
const defaultSettings = {
    enabled: true,
    googleApiKey: '',  // 用户自己的 Google AI API Key
    keepRecentMessages: 10,
    summaryMaxWords: 500,  // 每次增量压缩的摘要字数
    maxTotalSummaryLength: 2000,  // 总摘要最大长度，超过则压缩总摘要
    retrieveCount: 5,
    similarityThreshold: 0.3,
    skipVectorize: true,
    position: extension_prompt_types.IN_PROMPT,
    depth: 2,
    hideCompressedMessages: false,
    showRetrieved: false,  // 是否显示检索结果
    summaryPrompt: `用最精简的方式总结以下对话，要求：
1.用分号分隔不同事件，不要换行
2.省略所有不必要的标点、空格、连接词
3.只保留关键信息：人物行为、重要事件、关系变化、地点转换
4.用简短词组而非完整句子
5.限制在{{words}}字以内
格式示例：角色A做了X;B回应Y;发生Z事件;地点转到W`,
    injectionTemplate: `[前情提要]
{{summary}}

[相关历史片段]
{{retrieved}}`,
};

// Initialize extension settings
function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    // Apply defaults for missing settings
    for (const key in defaultSettings) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    // Update UI with current settings
    $('#chat_compressor_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#chat_compressor_google_api_key').val(extension_settings[MODULE_NAME].googleApiKey);
    $('#chat_compressor_keep_recent').val(extension_settings[MODULE_NAME].keepRecentMessages);
    $('#chat_compressor_summary_words').val(extension_settings[MODULE_NAME].summaryMaxWords);
    $('#chat_compressor_max_total_summary').val(extension_settings[MODULE_NAME].maxTotalSummaryLength);
    $('#chat_compressor_retrieve_count').val(extension_settings[MODULE_NAME].retrieveCount);
    $('#chat_compressor_threshold').val(extension_settings[MODULE_NAME].similarityThreshold);
    $('#chat_compressor_threshold_value').text(extension_settings[MODULE_NAME].similarityThreshold);
    $('#chat_compressor_skip_vectorize').prop('checked', extension_settings[MODULE_NAME].skipVectorize);
    $('#chat_compressor_position').val(extension_settings[MODULE_NAME].position);
    $('#chat_compressor_depth').val(extension_settings[MODULE_NAME].depth);
    $('#chat_compressor_hide_compressed').prop('checked', extension_settings[MODULE_NAME].hideCompressedMessages);
    $('#chat_compressor_summary_prompt').val(extension_settings[MODULE_NAME].summaryPrompt);
    $('#chat_compressor_injection_template').val(extension_settings[MODULE_NAME].injectionTemplate);
    $('#chat_compressor_show_retrieved').prop('checked', extension_settings[MODULE_NAME].showRetrieved);

    // 根据设置显示/隐藏检索结果区域
    if (extension_settings[MODULE_NAME].showRetrieved) {
        $('#chat_compressor_retrieved_block').show();
    } else {
        $('#chat_compressor_retrieved_block').hide();
    }

    updateStatusDisplay();
}

/**
 * Get the unique collection ID for the current chat
 * @returns {string|null} Collection ID or null if no chat is active
 */
function getCollectionId() {
    const chatId = getCurrentChatId();
    if (!chatId) return null;

    const prefix = selected_group ? `group_${selected_group}` : `chat_${chatId}`;
    return `compressor_${getStringHash(prefix)}`;
}

/**
 * Get compression data from chat metadata
 * @returns {object|null} Compression data or null
 */
function getCompressionData() {
    if (!chat_metadata) return null;
    return chat_metadata[MODULE_NAME] || null;
}

/**
 * Save compression data to chat metadata
 * @param {object} data Compression data to save
 */
function setCompressionData(data) {
    if (!chat_metadata) return;
    chat_metadata[MODULE_NAME] = data;
    saveMetadataDebounced();
}

/**
 * Update the status display in the UI
 */
function updateStatusDisplay() {
    const data = getCompressionData();
    const statusElement = $('#chat_compressor_status');
    const summaryElement = $('#chat_compressor_current_summary');

    if (!data || !data.summary) {
        statusElement.text('暂无压缩数据');
        summaryElement.val('');
    } else {
        const compressedCount = data.compressedMessageCount || 0;
        const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleString() : '未知';
        const hasVectors = data.vectors && data.vectors.length > 0 ? '是' : '否';
        const vectorCount = data.vectors ? data.vectors.length : 0;
        statusElement.html(`已压缩 <b>${compressedCount}</b> 条消息<br>向量化: ${hasVectors} (${vectorCount}条)<br>更新时间: ${timestamp}`);
        summaryElement.val(data.summary);
    }
}

/**
 * Call Google AI Embedding API directly
 * @param {string} text Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
async function getGoogleEmbedding(text) {
    const apiKey = extension_settings[MODULE_NAME].googleApiKey;

    if (!apiKey) {
        throw new Error('请先设置 Google AI API Key');
    }

    const response = await fetch(`${GOOGLE_EMBEDDING_API}?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            content: {
                parts: [{ text: text }]
            }
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('[Chat Compressor] Google Embedding API 错误:', response.status, errorText);
        throw new Error(`Embedding API 错误 (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    return result.embedding.values;
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a First vector
 * @param {number[]} b Second vector
 * @returns {number} Similarity score (0-1)
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compress the chat history (incremental)
 */
async function compressChat() {
    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        toastr.warning('没有可压缩的聊天记录');
        return;
    }

    const keepRecent = extension_settings[MODULE_NAME].keepRecentMessages;

    if (chat.length <= keepRecent) {
        toastr.info(`聊天只有 ${chat.length} 条消息，需要超过 ${keepRecent} 条才能压缩`);
        return;
    }

    // 获取已有的压缩数据
    const existingData = getCompressionData() || {};
    const previouslyCompressedIndex = existingData.compressedUntilIndex || 0;

    // 计算需要压缩的消息范围
    const toCompressEndIndex = chat.length - keepRecent;

    // 检查是否有新消息需要压缩
    if (toCompressEndIndex <= previouslyCompressedIndex) {
        toastr.info('没有新的消息需要压缩');
        return;
    }

    // Show progress
    const toast = toastr.info('正在压缩聊天记录...', '请稍候', { timeOut: 0, extendedTimeOut: 0 });

    try {
        // 只获取新增的消息（增量压缩）
        const newMessages = chat.slice(previouslyCompressedIndex, toCompressEndIndex);
        const filteredNewMessages = newMessages.filter(m => !m.is_system && m.mes);

        if (filteredNewMessages.length === 0) {
            toastr.clear(toast);
            toastr.warning('过滤后没有新消息需要压缩');
            return;
        }

        const isIncremental = previouslyCompressedIndex > 0;
        console.log(`[Chat Compressor] ${isIncremental ? '增量' : '首次'}压缩: ${filteredNewMessages.length} 条新消息 (索引 ${previouslyCompressedIndex} - ${toCompressEndIndex})`);

        // Step 1: Generate summary for new messages
        toastr.clear(toast);
        const summaryToast = toastr.info(
            isIncremental ? '正在生成增量摘要...' : '正在生成摘要...',
            '请稍候',
            { timeOut: 0, extendedTimeOut: 0 }
        );

        let newSummary;
        try {
            newSummary = await generateSummary(filteredNewMessages);
        } catch (summaryError) {
            toastr.clear(summaryToast);
            console.error('[Chat Compressor] 摘要生成异常:', summaryError);
            toastr.error(`摘要生成失败: ${summaryError.message || '未知错误'}`, '请检查控制台');
            return;
        }

        toastr.clear(summaryToast);

        if (!newSummary) {
            toastr.error('摘要生成失败，API返回空结果');
            return;
        }

        // Step 2: Merge summaries
        let totalSummary;
        if (isIncremental && existingData.summary) {
            // 拼接旧摘要和新摘要
            totalSummary = existingData.summary + '\n---\n' + newSummary;
            console.log(`[Chat Compressor] 合并摘要: 旧${existingData.summary.length}字 + 新${newSummary.length}字 = ${totalSummary.length}字`);
        } else {
            totalSummary = newSummary;
        }

        // Step 3: Check if total summary exceeds limit
        const maxLength = extension_settings[MODULE_NAME].maxTotalSummaryLength;
        if (totalSummary.length > maxLength) {
            console.log(`[Chat Compressor] 总摘要 ${totalSummary.length} 字超过阈值 ${maxLength}，正在压缩总摘要...`);
            const compressSummaryToast = toastr.info('总摘要过长，正在压缩...', '请稍候', { timeOut: 0, extendedTimeOut: 0 });

            try {
                totalSummary = await compressTotalSummary(totalSummary, maxLength);
                toastr.clear(compressSummaryToast);
                console.log(`[Chat Compressor] 总摘要已压缩至 ${totalSummary.length} 字`);
            } catch (error) {
                toastr.clear(compressSummaryToast);
                console.error('[Chat Compressor] 压缩总摘要失败:', error);
                toastr.warning('压缩总摘要失败，保留原摘要');
            }
        }

        // Step 4: Vectorize new messages (if not skipped)
        let newVectors = [];
        if (!extension_settings[MODULE_NAME].skipVectorize) {
            const apiKey = extension_settings[MODULE_NAME].googleApiKey;
            if (!apiKey) {
                toastr.warning('未设置 Google AI API Key，跳过向量化');
            } else {
                console.log(`[Chat Compressor] 正在向量化 ${filteredNewMessages.length} 条新消息`);
                const vectorToast = toastr.info('正在向量化新消息...', '0%', { timeOut: 0, extendedTimeOut: 0 });

                try {
                    // 向量化时添加偏移量，确保索引正确
                    newVectors = await vectorizeMessages(filteredNewMessages, (progress) => {
                        $('.toast-message').text(`${progress}%`);
                    }, previouslyCompressedIndex);
                    toastr.clear(vectorToast);
                } catch (vectorError) {
                    toastr.clear(vectorToast);
                    console.error('[Chat Compressor] 向量化失败:', vectorError);
                    toastr.warning(`向量化失败: ${vectorError.message}`);
                }
            }
        }

        // 合并旧向量和新向量
        const existingVectors = existingData.vectors || [];
        const allVectors = [...existingVectors, ...newVectors];

        // Step 5: Save compression data
        const totalCompressedCount = (existingData.compressedMessageCount || 0) + filteredNewMessages.length;

        const compressionData = {
            summary: totalSummary,
            compressedMessageCount: totalCompressedCount,
            compressedUntilIndex: toCompressEndIndex,
            vectors: allVectors,
            timestamp: Date.now(),
        };

        setCompressionData(compressionData);
        updateStatusDisplay();

        const vectorInfo = newVectors.length > 0 ? `，新增向量 ${newVectors.length} 条` : '';
        const mode = isIncremental ? '增量压缩' : '压缩';
        toastr.success(`${mode}完成: 新增 ${filteredNewMessages.length} 条，共 ${totalCompressedCount} 条${vectorInfo}`);

    } catch (error) {
        console.error('[Chat Compressor] 压缩失败:', error);
        toastr.error('压缩失败: ' + error.message);
    }
}

/**
 * Compress the total summary when it exceeds the limit
 * @param {string} summary The total summary to compress
 * @param {number} targetLength Target length
 * @returns {Promise<string>} Compressed summary
 */
async function compressTotalSummary(summary, targetLength) {
    const prompt = `你是一个摘要压缩专家。请将以下摘要精简到${targetLength}字以内，保留最重要的信息：

要求：
1. 保留关键人物、事件、关系变化
2. 删除重复信息
3. 使用更精简的表达
4. 保持时间顺序

原摘要：
${summary}`;

    const compressed = await generateRaw({
        prompt: prompt,
        systemPrompt: '你是摘要压缩助手，将长摘要精简为更短的版本，保留核心信息。',
    });

    return compressSummaryText(compressed);
}

/**
 * Compress the summary text to reduce token usage
 * @param {string} text The summary text to compress
 * @returns {string} Compressed text
 */
function compressSummaryText(text) {
    if (!text) return text;

    let result = text;

    result = result.replace(/\n+/g, ';');
    result = result.replace(/\s+/g, ' ');
    result = result.replace(/\s*;\s*/g, ';');
    result = result.replace(/\s*:\s*/g, ':');
    result = result.replace(/\s+,/g, ',');
    result = result.replace(/;+/g, ';');
    result = result.replace(/^;+|;+$/g, '');
    result = result.replace(/\*+/g, '');
    result = result.replace(/#+\s*/g, '');
    result = result.replace(/_+/g, '');
    result = result.replace(/["""'']/g, '');
    result = result.replace(/\(\s*\)/g, '');
    result = result.replace(/\[\s*\]/g, '');

    return result.trim();
}

/**
 * Generate a summary for the given messages
 * @param {Array} messages Messages to summarize
 * @returns {Promise<string>} Summary text
 */
async function generateSummary(messages) {
    const chatText = messages.map(m => `${m.name}:${m.mes}`).join('\n');

    const promptTemplate = extension_settings[MODULE_NAME].summaryPrompt;
    const maxWords = extension_settings[MODULE_NAME].summaryMaxWords;
    const prompt = substituteParamsExtended(promptTemplate, { words: maxWords });

    console.log('[Chat Compressor] 准备生成摘要...');
    console.log('[Chat Compressor] 聊天文本长度:', chatText.length);

    try {
        const rawSummary = await generateRaw({
            prompt: chatText,
            systemPrompt: prompt,
        });

        if (!rawSummary) {
            console.error('[Chat Compressor] API返回空结果');
            return null;
        }

        const summary = compressSummaryText(rawSummary);

        console.log('[Chat Compressor] 摘要生成成功');
        console.log('[Chat Compressor] 原始长度:', rawSummary.length, '压缩后:', summary.length);

        return summary;
    } catch (error) {
        console.error('[Chat Compressor] 摘要生成失败:', error);
        throw error;
    }
}

/**
 * Vectorize messages using Google AI Embedding API
 * @param {Array} messages Messages to vectorize
 * @param {Function} onProgress Progress callback
 * @param {number} indexOffset Index offset for incremental vectorization
 * @returns {Promise<Array>} Array of {text, vector} objects
 */
async function vectorizeMessages(messages, onProgress, indexOffset = 0) {
    const vectors = [];

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const text = `${m.name}: ${m.mes}`;

        try {
            // 截断过长的文本
            const truncatedText = text.length > 2000 ? text.substring(0, 2000) : text;
            const vector = await getGoogleEmbedding(truncatedText);

            vectors.push({
                text: text,
                vector: vector,
                index: indexOffset + i,  // 添加偏移量
            });

            // 更新进度
            const progress = Math.round(((i + 1) / messages.length) * 100);
            if (onProgress) onProgress(progress);

            console.log(`[Chat Compressor] 向量化进度: ${progress}% (${i + 1}/${messages.length})`);

            // 添加小延迟避免 API 限流
            if (i < messages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error(`[Chat Compressor] 向量化消息 ${i} 失败:`, error);
            // 继续处理其他消息
        }
    }

    return vectors;
}

/**
 * Query vectors for relevant content using local similarity calculation
 * @param {string} query Query text
 * @returns {Promise<Array>} Retrieved messages
 */
async function queryVectors(query) {
    const data = getCompressionData();
    if (!data || !data.vectors || data.vectors.length === 0) {
        console.log('[Chat Compressor] 跳过向量查询: 无向量数据');
        return [];
    }

    const apiKey = extension_settings[MODULE_NAME].googleApiKey;
    if (!apiKey) {
        console.log('[Chat Compressor] 跳过向量查询: 未设置 API Key');
        return [];
    }

    const topK = extension_settings[MODULE_NAME].retrieveCount;
    const threshold = extension_settings[MODULE_NAME].similarityThreshold;

    console.log(`[Chat Compressor] 正在查询向量，关键词: "${query.substring(0, 50)}..."`);

    try {
        // 获取查询文本的向量
        const queryVector = await getGoogleEmbedding(query.substring(0, 2000));

        // 计算与所有存储向量的相似度
        const similarities = data.vectors.map(item => ({
            text: item.text,
            index: item.index,
            similarity: cosineSimilarity(queryVector, item.vector),
        }));

        // 按相似度排序，过滤低于阈值的，取前 topK 个
        const results = similarities
            .filter(item => item.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, topK);

        console.log(`[Chat Compressor] 检索到 ${results.length} 条相关记录`);
        results.forEach(r => console.log(`  - 相似度 ${r.similarity.toFixed(3)}: ${r.text.substring(0, 50)}...`));

        return results;
    } catch (error) {
        console.error('[Chat Compressor] 向量查询错误:', error);
        return [];
    }
}

/**
 * Update the retrieved results display in UI
 * @param {Array} results Retrieved results
 * @param {string} query Query text
 */
function updateRetrievedDisplay(results, query) {
    if (!extension_settings[MODULE_NAME].showRetrieved) return;

    const infoElement = $('#chat_compressor_retrieved_info');
    const contentElement = $('#chat_compressor_retrieved_content');

    if (!results || results.length === 0) {
        infoElement.html(`查询: "${query.substring(0, 30)}..."<br>结果: 未找到相关内容`);
        contentElement.val('');
        return;
    }

    const timestamp = new Date().toLocaleTimeString();
    infoElement.html(`
        <b>查询:</b> "${query.substring(0, 50)}..."<br>
        <b>结果:</b> ${results.length} 条匹配 | <b>时间:</b> ${timestamp}
    `);

    const displayText = results.map((r, i) => {
        const similarity = (r.similarity * 100).toFixed(1);
        return `[#${i + 1} 相似度: ${similarity}%]\n${r.text}`;
    }).join('\n\n' + '─'.repeat(40) + '\n\n');

    contentElement.val(displayText);
}

/**
 * Clear all compression data for current chat
 */
async function clearCompressionData() {
    setCompressionData(null);
    updateStatusDisplay();
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0);

    toastr.success('压缩数据已清除');
}

/**
 * Build and inject the compression prompt
 * @param {string} userMessage Latest user message for context
 */
async function injectCompressionPrompt(userMessage) {
    if (!extension_settings[MODULE_NAME].enabled) {
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    const data = getCompressionData();
    if (!data || !data.summary) {
        return;
    }

    // Query for relevant content (only if we have vectors)
    let retrievedText = '';
    if (userMessage && data.vectors && data.vectors.length > 0) {
        try {
            const retrieved = await queryVectors(userMessage);

            // 更新 UI 显示
            updateRetrievedDisplay(retrieved, userMessage);

            if (retrieved && retrieved.length > 0) {
                retrievedText = retrieved.map(r => r.text).join('\n\n');
                console.log(`[Chat Compressor] 检索到 ${retrieved.length} 条相关历史，注入长度: ${retrievedText.length}`);
            } else {
                console.log('[Chat Compressor] 未检索到相关历史');
            }
        } catch (error) {
            console.error('[Chat Compressor] 检索失败:', error);
            updateRetrievedDisplay([], userMessage);
        }
    } else if (!data.vectors || data.vectors.length === 0) {
        console.log('[Chat Compressor] 当前聊天未启用向量化，仅使用摘要');
        updateRetrievedDisplay(null, userMessage || '');
    }

    // Build injection text using template
    const template = extension_settings[MODULE_NAME].injectionTemplate;
    let injectionText = template
        .replace('{{summary}}', data.summary)
        .replace('{{retrieved}}', retrievedText || '(无相关历史片段)');

    // Inject using ST's extension prompt system
    const position = extension_settings[MODULE_NAME].position;
    const depth = extension_settings[MODULE_NAME].depth;

    setExtensionPrompt(EXTENSION_PROMPT_TAG, injectionText, position, depth, false, extension_prompt_roles.SYSTEM);

    console.log('[Chat Compressor] 已注入压缩数据');
}

/**
 * Generation interceptor - removes compressed messages from the prompt
 */
globalThis.chatCompressorInterceptor = function(chat, contextSize, abort, type) {
    if (!extension_settings[MODULE_NAME]?.enabled || !extension_settings[MODULE_NAME]?.hideCompressedMessages) {
        return;
    }

    const data = getCompressionData();
    if (!data || !data.summary) {
        return;
    }

    const keepRecent = extension_settings[MODULE_NAME].keepRecentMessages;

    if (chat.length <= keepRecent) {
        console.log(`[Chat Compressor] 消息数量 ${chat.length} 不超过保留数量 ${keepRecent}，跳过移除`);
        return;
    }

    const removeCount = chat.length - keepRecent;
    chat.splice(0, removeCount);

    console.log(`[Chat Compressor] 拦截器已移除 ${removeCount} 条已压缩的消息，保留 ${chat.length} 条`);
};

/**
 * Handle chat changed event
 */
function onChatChanged() {
    updateStatusDisplay();
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0);
}

/**
 * Handle generation started event
 */
async function onGenerationStarted(type, options, dryRun) {
    if (dryRun) return;

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) return;

    // Find the latest user message
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes) {
            await injectCompressionPrompt(chat[i].mes);
            break;
        }
    }
}

/**
 * Test Google AI API Key
 */
async function testApiKey() {
    const apiKey = $('#chat_compressor_google_api_key').val();

    if (!apiKey) {
        toastr.warning('请先输入 API Key');
        return;
    }

    const testToast = toastr.info('正在测试 API Key...', '请稍候', { timeOut: 0, extendedTimeOut: 0 });

    try {
        const response = await fetch(`${GOOGLE_EMBEDDING_API}?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                content: {
                    parts: [{ text: 'test' }]
                }
            }),
        });

        toastr.clear(testToast);

        if (response.ok) {
            toastr.success('API Key 有效！');
            // 保存 API Key
            extension_settings[MODULE_NAME].googleApiKey = apiKey;
            saveSettingsDebounced();
        } else {
            const errorText = await response.text();
            toastr.error(`API Key 无效: ${response.status}`);
            console.error('[Chat Compressor] API Key 测试失败:', errorText);
        }
    } catch (error) {
        toastr.clear(testToast);
        toastr.error('测试失败: ' + error.message);
    }
}

/**
 * Setup event listeners for settings UI
 */
function setupListeners() {
    // Compress button
    $('#chat_compressor_compress_btn').on('click', compressChat);

    // Clear button
    $('#chat_compressor_clear_btn').on('click', async () => {
        if (confirm('确定要清除当前聊天的所有压缩数据吗？')) {
            await clearCompressionData();
        }
    });

    // Test API Key button
    $('#chat_compressor_test_api_key').on('click', testApiKey);

    // API Key input
    $('#chat_compressor_google_api_key').on('change', function() {
        extension_settings[MODULE_NAME].googleApiKey = $(this).val();
        saveSettingsDebounced();
    });

    // Enable checkbox
    $('#chat_compressor_enabled').on('change', function() {
        extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Skip vectorize checkbox
    $('#chat_compressor_skip_vectorize').on('change', function() {
        extension_settings[MODULE_NAME].skipVectorize = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Hide compressed messages checkbox
    $('#chat_compressor_hide_compressed').on('change', function() {
        extension_settings[MODULE_NAME].hideCompressedMessages = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Show retrieved results checkbox
    $('#chat_compressor_show_retrieved').on('change', function() {
        const isChecked = $(this).prop('checked');
        extension_settings[MODULE_NAME].showRetrieved = isChecked;
        saveSettingsDebounced();

        if (isChecked) {
            $('#chat_compressor_retrieved_block').slideDown();
        } else {
            $('#chat_compressor_retrieved_block').slideUp();
        }
    });

    // Number inputs
    $('#chat_compressor_keep_recent').on('change', function() {
        extension_settings[MODULE_NAME].keepRecentMessages = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#chat_compressor_summary_words').on('change', function() {
        extension_settings[MODULE_NAME].summaryMaxWords = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#chat_compressor_max_total_summary').on('change', function() {
        extension_settings[MODULE_NAME].maxTotalSummaryLength = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#chat_compressor_retrieve_count').on('change', function() {
        extension_settings[MODULE_NAME].retrieveCount = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#chat_compressor_depth').on('change', function() {
        extension_settings[MODULE_NAME].depth = Number($(this).val());
        saveSettingsDebounced();
    });

    // Slider input
    $('#chat_compressor_threshold').on('input', function() {
        const value = $(this).val();
        $('#chat_compressor_threshold_value').text(value);
        extension_settings[MODULE_NAME].similarityThreshold = Number(value);
        saveSettingsDebounced();
    });

    // Select inputs
    $('#chat_compressor_position').on('change', function() {
        extension_settings[MODULE_NAME].position = Number($(this).val());
        saveSettingsDebounced();
    });

    // Textarea inputs
    $('#chat_compressor_summary_prompt').on('input', debounce(function() {
        extension_settings[MODULE_NAME].summaryPrompt = $(this).val();
        saveSettingsDebounced();
    }, debounce_timeout.standard));

    $('#chat_compressor_injection_template').on('input', debounce(function() {
        extension_settings[MODULE_NAME].injectionTemplate = $(this).val();
        saveSettingsDebounced();
    }, debounce_timeout.standard));

    // Edit summary functionality
    let originalSummary = '';

    $('#chat_compressor_edit_summary_btn').on('click', function() {
        const summaryElement = $('#chat_compressor_current_summary');
        originalSummary = summaryElement.val();
        summaryElement.prop('readonly', false);
        $(this).hide();
        $('#chat_compressor_save_summary_btn, #chat_compressor_cancel_edit_btn').show();
    });

    $('#chat_compressor_save_summary_btn').on('click', function() {
        const newSummary = $('#chat_compressor_current_summary').val();
        const data = getCompressionData();
        if (data) {
            data.summary = newSummary;
            data.timestamp = Date.now();
            setCompressionData(data);
        } else {
            setCompressionData({
                summary: newSummary,
                compressedMessageCount: 0,
                vectors: [],
                timestamp: Date.now(),
            });
        }
        $('#chat_compressor_current_summary').prop('readonly', true);
        $(this).hide();
        $('#chat_compressor_cancel_edit_btn').hide();
        $('#chat_compressor_edit_summary_btn').show();
        updateStatusDisplay();
        toastr.success('摘要已更新');
    });

    $('#chat_compressor_cancel_edit_btn').on('click', function() {
        $('#chat_compressor_current_summary').val(originalSummary).prop('readonly', true);
        $(this).hide();
        $('#chat_compressor_save_summary_btn').hide();
        $('#chat_compressor_edit_summary_btn').show();
    });
}

// Initialize the extension
jQuery(async function() {
    // Load settings HTML - 尝试多种路径
    let settingsHtml = '';
    const possiblePaths = [
        'scripts/extensions/third-party/chat-compressor/settings.html',
        '/scripts/extensions/third-party/chat-compressor/settings.html',
    ];

    for (const path of possiblePaths) {
        try {
            const response = await fetch(path);
            if (response.ok) {
                settingsHtml = await response.text();
                console.log(`[Chat Compressor] 成功从 ${path} 加载模板`);
                break;
            }
        } catch (e) {
            console.log(`[Chat Compressor] 尝试路径 ${path} 失败`);
        }
    }

    // 如果 fetch 失败，尝试使用 renderExtensionTemplateAsync
    if (!settingsHtml) {
        try {
            settingsHtml = await renderExtensionTemplateAsync('third-party/chat-compressor', 'settings');
            console.log('[Chat Compressor] 使用 renderExtensionTemplateAsync 加载模板');
        } catch (e) {
            console.error('[Chat Compressor] 模板加载失败:', e);
            toastr.error('Chat Compressor 模板加载失败，请检查安装路径');
            return;
        }
    }

    $('#extensions_settings2').append(settingsHtml);

    // Load settings
    loadSettings();

    // Setup UI listeners
    setupListeners();

    // Setup event listeners
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    console.log('[Chat Compressor] 扩展已加载');
});
