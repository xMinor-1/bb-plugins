// Ready-made requests for an agent's chat: the page opens a new thread with one of them in the
// message field. The person changes the words (the "…" parts) and sends it.
import type { Lang } from "@/lib/i18n";

export interface Ask {
  readonly title: string;
  readonly prompt: string;
}

export const ASKS: Record<Lang, readonly Ask[]> = {
  en: [
    { title: "What is new for me", prompt: "Go through my messenger chats with unread messages. For each, tell me in one or two sentences who writes what and what they expect from me." },
    { title: "Catch up on a chat", prompt: "Find the chat with … in the messenger and tell me what we discussed in the last messages and what is left open." },
    { title: "Questions waiting for me", prompt: "Look through my messenger chats with unread messages and list the questions and requests addressed to me that nobody has answered yet." },
    { title: "Reply in a chat", prompt: "Find the chat with … in the messenger, read the last messages and draft a reply: … Show me the text before sending." },
    { title: "Watch a chat", prompt: "Watch the chat … in the messenger: when it gets unread messages, tell me what is going on there." },
  ],
  ru: [
    { title: "Что нового для меня", prompt: "Пройди по моим чатам в мессенджере с непрочитанными сообщениями. По каждому одним-двумя предложениями: кто что пишет и чего ждут от меня." },
    { title: "Догнать чат", prompt: "Найди в мессенджере чат с … и расскажи, что мы обсуждали в последних сообщениях и что осталось открытым." },
    { title: "Вопросы ко мне", prompt: "Просмотри мои чаты в мессенджере с непрочитанными сообщениями и перечисли вопросы и просьбы ко мне, на которые ещё никто не ответил." },
    { title: "Ответить в чат", prompt: "Найди в мессенджере чат с …, прочитай последние сообщения и подготовь ответ: … Покажи текст перед отправкой." },
    { title: "Сторожить чат", prompt: "Сторожи чат … в мессенджере: когда там появятся непрочитанные сообщения, расскажи, что происходит." },
  ],
};
