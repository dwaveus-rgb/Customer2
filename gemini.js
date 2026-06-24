const OpenAI = require('openai');

class GeminiChat {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.client = apiKey ? new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    }) : null;
    this.model = 'openrouter/free';
  }

  updateKey(key) {
    this.apiKey = key;
    this.client = key ? new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
    }) : null;
    console.log('[Gemini] API key', key ? 'updated' : 'cleared');
  }

  async generateReply(botName, personality, topic, recentMessages = [], maxLength = 200, customPrompt = '') {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');

    const styleSection = customPrompt
      ? `\nTalking Style:\n${customPrompt}\n`
      : '';

    const systemPrompt = `You are ${botName}, a real person in their 20s in a Discord group chat.

Personality: ${personality}
Topic everyone is discussing: ${topic}
${styleSection}
You MUST talk about this topic. Share opinions, ask questions, react to what others say about it.

Style:
- 1-2 short sentences, like texting a friend
- Casual lowercase, lazy grammar is fine
- Give real opinions, not just "lol" or "fr"
- React to what others said, then add your own take
- Examples: "honestly i think discord is way better than slack for communities", "wait do yall actually use servers tho or just dms", "the best part is definitely the voice channels ngl"
- No emojis, never mention being AI

Chat history:
${history || 'No messages yet.'}

What does ${botName} say next?`;

    if (!this.client) {
      console.warn('[Gemini] No API key set, using fallback');
      return this.smartFallback(topic);
    }

    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt }
        ],
        max_tokens: 50,
        temperature: 0.9,
      });

      if (!result || !result.choices || !result.choices.length) {
        console.warn('[Gemini] Empty response from API, using fallback');
        return this.smartFallback(topic);
      }

      let response = result.choices[0]?.message?.content?.trim() || '';
      response = this.cleanResponse(response, botName, maxLength);
      return response;
    } catch (err) {
      console.error('[OpenRouter Error]', err.message);
      return this.smartFallback(topic);
    }
  }

  async generateTopicStarter(botName, personality, topic, customPrompt = '') {
    const styleSection = customPrompt
      ? `\nTalking Style:\n${customPrompt}\n`
      : '';

    const systemPrompt = `You are ${botName}, a real person in a Discord group chat.

Personality: ${personality}
Topic: ${topic}
${styleSection}
Start a natural conversation about this topic. Share an opinion or ask a question.

Style:
- 1 sentence, casual and conversational
- Lowercase, lazy grammar
- Examples: "honestly what do yall think about ${topic}", "i feel like nobody talks about ${topic} enough", "unpopular opinion but ${topic} is actually overrated"
- No emojis, never mention being AI
- Write ONLY the message, nothing else`;

    if (!this.client) {
      console.warn('[Gemini] No API key set, using fallback');
      return this.topicFallback(topic);
    }

    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt }
        ],
        max_tokens: 40,
        temperature: 0.9,
      });

      let response = result.choices[0]?.message?.content?.trim() || '';
      return this.cleanResponse(response, botName, 120);
    } catch (err) {
      console.error('[OpenRouter Error]', err.message);
      return this.topicFallback(topic);
    }
  }

  cleanResponse(text, botName, maxLength) {
    text = text.replace(/^["']|["']$/g, '');
    text = text.replace(new RegExp(`^(bot|${botName}|assistant|ai):?\\s*`, 'gi'), '');
    text = text.replace(/^>\s*/, '');
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
    if (text.length > maxLength) {
      text = text.substring(0, maxLength);
      const lastSpace = text.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.5) text = text.substring(0, lastSpace);
    }
    return text.trim();
  }

  smartFallback(topic) {
    const replies = [
      `honestly i think ${topic} is lowkey overrated`,
      `wait thats actually a good point about ${topic}`,
      `nah bc think about it, ${topic} matters more than people realize`,
      `i feel like nobody actually cares about ${topic} tho`,
      `thats interesting, what made u think about ${topic}`,
      `ok but have u considered the other side of ${topic}`,
      `ngl ${topic} has been on my mind a lot lately`,
      `thats cap, ${topic} is actually really important`
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
}

module.exports = GeminiChat;
