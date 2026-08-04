// 平台数据类型（对齐需求文档 §5 与句子池产物）

export interface PoolToken {
  word: string;
  type?: "name";
}

export interface PoolSentence {
  id: string;
  round: string;
  topic: string;
  section: string;
  en: string;
  zh: string;
  tokens: PoolToken[];
  bold: string[];
}

export interface SentencePool {
  meta: { source: string; count: number };
  sentences: PoolSentence[];
}

// 落库后的行类型
export interface SentenceRow {
  id: number;
  en: string;
  zh: string;
  round: string | null;
  topic: string | null;
  section: string | null;
  source: string | null;
}

export interface WordRow {
  id: number;
  word: string;
  freq: number;
  is_name: number;
}
