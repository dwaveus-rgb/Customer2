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

  async chat(systemPrompt, maxTokens = 50) {
    if (!this.client) return null;
    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }],
        max_tokens: maxTokens,
        temperature: 0.9,
      });
      if (!result || !result.choices || !result.choices.length) return null;
      return result.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
      console.error('[OpenRouter Error]', err.message);
      return null;
    }
  }

  async generateReply(botName, personality, topic, recentMessages = [], maxLength = 200, customPrompt = '') {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = `You are ${botName}, a real person in their 20s in a Discord group chat.

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
- No emojis in text, never mention being AI

Chat history:
${history || 'No messages yet.'}

What does ${botName} say next?`;

    const response = await this.chat(prompt, 80);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.smartFallback(topic);
  }

  async generateReplyToMessage(botName, personality, topic, customPrompt, authorName, messageContent, recentMessages = [], maxLength = 200) {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = `You are ${botName}, a real person in their 20s in a Discord group chat.

Personality: ${personality}
Topic everyone is discussing: ${topic}
${styleSection}
${authorName} just said: "${messageContent}"

Reply directly to what they said. React to it, add your own take, ask a follow-up. Be natural.

Style:
- 1-2 short sentences, like texting a friend
- Casual lowercase, lazy grammar
- Give real opinions, not just "lol" or "fr"
- Reference what they actually said
- No emojis in text, never mention being AI

Recent chat:
${history || 'No messages yet.'}

What does ${botName} say?`;

    const response = await this.chat(prompt, 80);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.smartFallback(topic);
  }

  async generateFollowUp(botName, personality, topic, customPrompt, originalAuthor, originalMessage, recentMessages = [], maxLength = 200) {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = `You are ${botName}, a real person in their 20s in a Discord group chat.

Personality: ${personality}
Topic everyone is discussing: ${topic}
${styleSection}
${originalAuthor} just said: "${originalMessage}"

Continue the conversation. Respond to what they said, add your perspective, or build on it.

Style:
- 1-2 short sentences
- Casual lowercase, lazy grammar
- React naturally, add your own take
- No emojis in text, never mention being AI

Recent chat:
${history || 'No messages yet.'}

What does ${botName} say?`;

    const response = await this.chat(prompt, 80);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.smartFallback(topic);
  }

  async generateRedirect(botName, personality, topic, customPrompt, recentMessages = [], maxLength = 200) {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');
    const styleSection = customPrompt ? `\nTalking Style:\n${customPrompt}\n` : '';

    const prompt = `You are ${botName}, a real person in their 20s in a Discord group chat.

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

What does ${botName} say?`;

    const response = await this.chat(prompt, 40);
    if (response) return this.cleanResponse(response, botName, maxLength);
    return this.topicRedirectFallback(topic);
  }

  async checkOnTopic(messageContent, topic) {
    if (!this.client) return true;
    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: `Answer ONLY "yes" or "no". Is this message about or related to the topic "${topic}"? Message: "${messageContent}"` }
        ],
        max_tokens: 3,
        temperature: 0,
      });
      const answer = result.choices[0]?.message?.content?.trim().toLowerCase() || '';
      return answer.startsWith('yes');
    } catch {
      return true;
    }
  }

  cleanResponse(text, botName, maxLength) {
    text = text.replace(/^["']|["']$/g, '');
    text = text.replace(new RegExp(`^(bot|${botName}|assistant|ai):?\\s*`, 'gi'), '');
    text = text.replace(/^>\s*/, '');
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
    // Collapse multi-line to single line, take only first sentence if multi-sentence
    text = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    const lines = text.split(/\.\s/);
    if (lines.length > 1) text = lines[0] + '.';
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
