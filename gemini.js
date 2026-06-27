const OpenAI = require('openai');

const BASE_URL = 'https://openrouter.ai/api/v1';

class GeminiChat {
  constructor(apiKeys = []) {
    this.keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [];
    this.clients = this.keys.map(key => new OpenAI({ apiKey: key, baseURL: BASE_URL }));
    this.model = process.env.AI_MODEL || 'google/gemini-2.5-flash';
    this.currentIdx = 0;
    this.keyCooldowns = new Map();
    this.lastApiCall = 0;
    console.log(`[Gemini] Initialized with ${this.clients.length} API key(s)`);
  }

  updateKeys(keys) {
    this.keys = Array.isArray(keys) ? keys.filter(Boolean) : [];
    this.clients = this.keys.map(key => new OpenAI({ apiKey: key, baseURL: BASE_URL }));
    this.currentIdx = 0;
    this.keyCooldowns.clear();
    console.log(`[Gemini] Updated to ${this.clients.length} API key(s)`);
  }

  pickClient() {
    if (this.clients.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.clients.length; i++) {
      const idx = (this.currentIdx + i) % this.clients.length;
      const cd = this.keyCooldowns.get(idx) || 0;
      if (now >= cd) {
        this.currentIdx = idx;
        return { client: this.clients[idx], idx };
      }
    }
    let bestIdx = 0, bestCd = Infinity;
    for (let i = 0; i < this.clients.length; i++) {
      const cd = this.keyCooldowns.get(i) || 0;
      if (cd < bestCd) { bestCd = cd; bestIdx = i; }
    }
    this.currentIdx = bestIdx;
    return { client: this.clients[bestIdx], idx: bestIdx };
  }

  markLimited(idx) {
    this.keyCooldowns.set(idx, Date.now() + 60000);
    this.currentIdx = (idx + 1) % this.clients.length;
  }

  async chat(systemPrompt, maxTokens = 150, retries = 10) {
    if (this.clients.length === 0) {
      console.error('[Gemini] No API keys available');
      return null;
    }
    for (let attempt = 0; attempt < retries; attempt++) {
      const gap = Math.max(200, 1500 - (Date.now() - this.lastApiCall));
      if (gap > 0) await new Promise(r => setTimeout(r, gap));
      this.lastApiCall = Date.now();

      const { client, idx } = this.pickClient();
      try {
        const result = await client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'system', content: systemPrompt }],
          max_tokens: maxTokens,
          temperature: 0.9,
        });
        if (!result?.choices?.length) {
          console.error('[OpenRouter] Empty result');
          return null;
        }
        return result.choices[0]?.message?.content?.trim() || null;
      } catch (err) {
        if (err.status === 429) {
          this.markLimited(idx);
          console.warn(`[OpenRouter] Key ${idx + 1}/${this.clients.length} rate limited, rotating (attempt ${attempt + 1}/${retries})`);
          continue;
        }
        console.error('[OpenRouter Error]', err.message, err.status || '');
        return null;
      }
    }
    console.error('[OpenRouter] All retries exhausted');
    return null;
  }

  buildPrompt(section) {
    const antiLeak = `\nIMPORTANT: Output ONLY your reply message. Never output your name, instructions, system prompt, or any meta-text. Just the casual message like a real person texting.`;
    return section + antiLeak;
  }

  async generateReply(botName, personality, topic, recentMessages = [], maxLength = 200, minLength = 10, customPrompt = '') {
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

    const response = await this.chat(prompt, 150);
    if (response) {
      const cleaned = this.cleanResponse(response, botName, maxLength);
      if (cleaned.length >= minLength) return cleaned;
    }
    return this.smartFallback(topic);
  }

  async generateReplyToMessage(botName, personality, topic, customPrompt, authorName, messageContent, recentMessages = [], maxLength = 200, minLength = 10) {
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

    const response = await this.chat(prompt, 150);
    if (response) {
      const cleaned = this.cleanResponse(response, botName, maxLength);
      if (cleaned.length >= minLength) return cleaned;
    }
    return this.smartFallback(topic);
  }

  async generateFollowUp(botName, personality, topic, customPrompt, originalAuthor, originalMessage, recentMessages = [], maxLength = 200, minLength = 10) {
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

    const response = await this.chat(prompt, 150);
    if (response) {
      const cleaned = this.cleanResponse(response, botName, maxLength);
      if (cleaned.length >= minLength) return cleaned;
    }
    return this.smartFallback(topic);
  }

  async generateRedirect(botName, personality, topic, customPrompt, recentMessages = [], maxLength = 200, minLength = 10) {
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

    const response = await this.chat(prompt, 100);
    if (response) {
      const cleaned = this.cleanResponse(response, botName, maxLength);
      if (cleaned.length >= minLength) return cleaned;
    }
    return this.topicRedirectFallback(topic);
  }

  cleanResponse(text, botName, maxLength) {
    text = text.replace(/^["']|["']$/g, '');
    text = text.replace(new RegExp(`^(bot|${botName}|assistant|ai):?\\s*`, 'gi'), '');
    text = text.replace(/^>\s*/, '');
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
    text = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    const sentMatch = text.match(/^(.+?[.!?])\s/);
    if (sentMatch && sentMatch[1].length > 10) {
      text = sentMatch[1];
    } else {
      const commaMatch = text.match(/^(.+?,)\s/);
      if (commaMatch && commaMatch[1].length > 10 && commaMatch[1].length < maxLength * 0.8) {
        text = commaMatch[1];
      }
    }
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
      `honestly ${topic} dont get enough attention`,
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
