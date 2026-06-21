const OpenAI = require('openai');

class GeminiChat {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey: apiKey || 'sk-placeholder',
      baseURL: 'https://openrouter.ai/api/v1',
    });
    this.model = 'openrouter/free';
  }

  updateKey(key) {
    this.apiKey = key;
    this.client = new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  async generateReply(botName, personality, topic, recentMessages = [], maxLength = 200) {
    const history = recentMessages.map(m => `${m.sender}: ${m.text}`).join('\n');

    const systemPrompt = `You are ${botName}. You are a real human chatting in a Discord server. Never say you are AI.

Personality: ${personality}

How to talk like a real person:
- Short messages, 5-15 words max
- Use incomplete sentences like real texting
- Mix it up: sometimes just "hmm", "wait what", "oh true", "nah"
- Use filler words: "lowkey", "ngl", "istg", "bc", "tbh", "imo"
- React naturally: "wait that's wild", "ok fair", "nah fr"
- Ask casual questions: "but why tho", "u think so?"
- Disagree sometimes: "cap", "nuh uh", "u sure about that"
- Never write essays, keep it lazy and casual
- No emojis at all
- All lowercase always
- NO "lol", "lmao", "fr", "real", "yeahh" as your only words

The topic is: ${topic}
If talking about the topic, give real opinions like a person would.

${history ? `Chat so far:\n${history}` : 'Chat is empty, start something casual.'}

Write ONLY your reply. Nothing else.`;

    const userPrompt = history
      ? `What do u say as ${botName}?`
      : `Start chatting as ${botName}`;

    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 30,
        temperature: 1.0,
      });

      let response = result.choices[0]?.message?.content?.trim() || '';
      response = this.cleanResponse(response, botName, maxLength);
      return response;
    } catch (err) {
      console.error('[OpenRouter Error]', err.message);
      return this.smartFallback(topic);
    }
  }

  async generateTopicStarter(botName, personality, topic) {
    const systemPrompt = `You are ${botName}, a real person texting in Discord. Not AI.

Personality: ${personality}

Write one short casual message about: ${topic}
- 5-12 words max
- Like texting a friend
- Can be a question, opinion, or random thought
- No emojis, all lowercase
- Don't announce the topic, just talk about it naturally
- Write ONLY the message`;

    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Say something as ${botName}` }
        ],
        max_tokens: 25,
        temperature: 1.0,
      });

      let response = result.choices[0]?.message?.content?.trim() || '';
      return this.cleanResponse(response, botName, 200);
    } catch (err) {
      console.error('[OpenRouter Error]', err.message);
      return this.topicFallback(topic);
    }
  }

  cleanResponse(text, botName, maxLength) {
    text = text.replace(/^["']|["']$/g, '');
    text = text.replace(new RegExp(`^(bot|${botName}|assistant|ai):?\\s*`, 'gi'), '');
    text = text.replace(/^>\s*/, '');
    text = text.replace(/^.*?:\s*/m, (match) => {
      if (match.length < 20) return '';
      return match;
    });
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
    if (text.length > maxLength) {
      text = text.substring(0, maxLength);
      const lastSpace = text.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.6) text = text.substring(0, lastSpace);
    }
    return text.trim();
  }

  smartFallback(topic) {
    const replies = [
      `idk i think ${topic} is lowkey overrated`,
      `nah thats not it`,
      `wait actually thats a good point`,
      `hmm i never thought about it that way`,
      `thats cap`,
      `I mean kinda but not really`,
      `nah bc think about it`,
      `ok but what about`,
      `thats actually interesting tho`,
      `I feel like it depends on the situation`
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  topicFallback(topic) {
    const starters = [
      `yo what do yall think about ${topic}`,
      `has anyone noticed how ${topic} has been lately`,
      `${topic} has been on my mind today`,
      `unpopular opinion but ${topic}`,
      `wait does anyone else care about ${topic} or is it just me`
    ];
    return starters[Math.floor(Math.random() * starters.length)];
  }
}

module.exports = GeminiChat;
