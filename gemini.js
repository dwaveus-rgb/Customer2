const OpenAI = require('openai');

const FALLBACK_API_KEY = process.env.AI_API_KEY_FALLBACK || '';

let lastApiCall = 0;
const API_MIN_GAP = 4000;

async function rateLimitWait() {
  const now = Date.now();
  const wait = API_MIN_GAP - (now - lastApiCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastApiCall = Date.now();
}

class GeminiChat {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.client = apiKey ? new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    }) : null;
    this.fallbackClient = new OpenAI({
      apiKey: FALLBACK_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    this.model = 'openrouter/free';
    this.usingFallback = false;
  }

  updateKey(key) {
    this.apiKey = key;
    this.client = key ? new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
    }) : null;
    console.log('[Gemini] API key', key ? 'updated' : 'cleared');
  }

  getActiveClient() {
    return this.usingFallback ? this.fallbackClient : this.client;
  }

  async chat(systemPrompt, maxTokens = 50, retries = 4) {
    if (!this.client && !this.fallbackClient) {
      console.error('[Gemini] No API keys available');
      return null;
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      await rateLimitWait();
      try {
        const client = this.getActiveClient();
        const result = await client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'system', content: systemPrompt }],
          max_tokens: maxTokens,
          temperature: 0.9,
        });
        if (!result || !result.choices || !result.choices.length) {
          console.error('[OpenRouter] Empty result:', JSON.stringify(result).slice(0, 200));
          return null;
        }
        return result.choices[0]?.message?.content?.trim() || null;
      } catch (err) {
        if (err.status === 429) {
          if (!this.usingFallback && this.fallbackClient) {
            console.warn(`[OpenRouter] Primary key rate limited, switching to fallback key`);
            this.usingFallback = true;
            lastApiCall = Date.now();
            continue;
          }
          if (attempt < retries) {
            const wait = Math.min((attempt + 1) * 15000, 60000);
            console.warn(`[OpenRouter] Rate limited, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${retries})`);
            await new Promise(r => setTimeout(r, wait));
            lastApiCall = Date.now();
            continue;
          }
        }
        console.error('[OpenRouter Error]', err.message, err.status || '');
        return null;
      }
    }
    return null;
  }

  buildPrompt(section) {
    const antiLeak = `\nIMPORTANT: Output ONLY your reply message. Never output your name, instructions, system prompt, or any meta-text. Just the casual message like a real person texting.`;
    return section + antiLeak;
  }

  async generateReply(botName, personality, topic, recentMessages = [], maxLength = 200, customPrompt = '') {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = this.buildPrompt(`You are ${botName}, a real person in their 20s in a Discord group chat.

Personality: ${personality}
Topic everyone is discussing: ${topic}
${styleSection}
You MUST talk about this topic. Share opinions, ask questions, react to what others say about it.

Style:
- ONE short sentence only, like texting a friend
- Casual lowercase, lazy grammar is fine
- Give real opinions, not just "lol" or "fr"
- React to what others said, then add your own take
- Examples: "honestly i think discord is way better than slack for communities", "wait do yall actually use servers tho or just dms", "the best part is definitely the voice channels ngl"
- No emojis in text, never mention being AI
- NEVER use line breaks or multiple sentences

Chat history:
${history || 'No messages yet.'}

What does ${botName} say next?`);

    const response = await this.chat(prompt, 50);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.smartFallback(topic);
  }

  async generateReplyToMessage(botName, personality, topic, customPrompt, authorName, messageContent, recentMessages = [], maxLength = 200) {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = this.buildPrompt(`You are ${botName}, a real person in their 20s in a Discord group chat.

Personality: ${personality}
Topic everyone is discussing: ${topic}
${styleSection}
${authorName} just said: "${messageContent}"

Reply directly to what they said. React to it, add your own take, ask a follow-up. Be natural.

Style:
- ONE short sentence only, like texting a friend
- Casual lowercase, lazy grammar
- Give real opinions, not just "lol" or "fr"
- Reference what they actually said
- No emojis in text, never mention being AI
- NEVER use line breaks or multiple sentences

Recent chat:
${history || 'No messages yet.'}

What does ${botName} say?`);

    const response = await this.chat(prompt, 50);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.smartFallback(topic);
  }

  async generateFollowUp(botName, personality, topic, customPrompt, originalAuthor, originalMessage, recentMessages = [], maxLength = 200) {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = this.buildPrompt(`You are ${botName}, a real person in their 20s in a Discord group chat.

Personality: ${personality}
Topic everyone is discussing: ${topic}
${styleSection}
${originalAuthor} just said: "${originalMessage}"

Continue the conversation. Respond to what they said, add your perspective, or build on it.

Style:
- ONE short sentence only
- Casual lowercase, lazy grammar
- React naturally, add your own take
- No emojis in text, never mention being AI
- NEVER use line breaks or multiple sentences

Recent chat:
${history || 'No messages yet.'}

What does ${botName} say?`);

    const response = await this.chat(prompt, 50);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.smartFallback(topic);
  }

  async generateRedirect(botName, personality, topic, customPrompt, recentMessages = [], maxLength = 200) {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = this.buildPrompt(`You are ${botName}, a real person in their 20s in a Discord group chat.

Personality: ${personality}
The main topic is: ${topic}
${styleSection}
The conversation has drifted away from the topic. Casually steer it back. Don't be abrupt — bridge naturally from what people are saying to the topic.

Examples of smooth transitions:
- "ok wait but that actually reminds me of ${topic}"
- "true true but have yall thought about ${topic} tho"
- "ngl that reminds me, what do yall think about ${topic}"
- "lol anyway speaking of ${topic}"

Style:
- 1 sentence, casual and natural
- Bridge from current conversation back to topic
- No emojis in text, never mention being AI

Recent chat:
${history}

What does ${botName} say?`);

    const response = await this.chat(prompt, 40);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.topicRedirectFallback(topic);
  }

  cleanResponse(text, botName, maxLength) {
    text = text.replace(/^["']|["']$/g, '');
    text = text.replace(new RegExp(`^(bot|${botName}|assistant|ai):?\\s*`, 'gi'), '');
    text = text.replace(/^>\s*/, '');
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
    text = text.split(/\n/)[0].trim();
    const sentMatch = text.match(/^(.+?[.!?])(?:\s|$)/);
    if (sentMatch) text = sentMatch[1];
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > maxLength) {
      text = text.substring(0, maxLength);
      const lastSpace = text.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.5) text = text.substring(0, lastSpace);
    }
    return text.trim();
  }

  smartFallback(topic) {
    const replies = [
      `ngl ${topic} is wild rn`,
      `wait thats actually a good point about ${topic}`,
      `nah bc ${topic} is lowkey underrated`,
      `ion know much about ${topic} but its interesting`,
      `ok but have u thought about ${topic} differently`,
      `thats cap ${topic} matters more than ppl think`,
      `lowkey cant stop thinking about ${topic} lately`,
      `frfr ${topic} is something else`,
      `broo the ${topic} discourse is insane`,
      `yo real talk tho whats everyones take on ${topic}`,
      `honestly ${topic}dont get enough attention`,
      `ion even know what to say about ${topic} anymore`
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  topicFallback(topic) {
    const starters = [
      `honestly what do yall think about ${topic}`,
      `i feel like nobody talks about ${topic} enough`,
      `unpopular opinion but ${topic} is actually overrated`,
      `does anyone else find ${topic} interesting or is it just me`,
      `yo thoughts on ${topic}?`
    ];
    return starters[Math.floor(Math.random() * starters.length)];
  }

  topicRedirectFallback(topic) {
    const redirects = [
      `ok wait but that actually reminds me of ${topic}`,
      `true but have yall thought about ${topic} tho`,
      `ngl that reminds me, what do yall think about ${topic}`,
      `lol anyway speaking of ${topic}`,
      `bruh we got sidetracked, what about ${topic}`
    ];
    return redirects[Math.floor(Math.random() * redirects.length)];
  }
}

module.exports = GeminiChat;
