// The one data file of stop words: words that say nothing about WHAT a task is about. The preflight pack (preflight.ts) matches an open task to
// a thread by the significant words its text shares with the thread's goal / title (at least two); these never count.
export const STOP_WORDS: readonly string[] = [
  'a', 'about', 'above', 'add', 'after', 'again', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'back', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can', 'check', 'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'fix', 'for', 'from',
  'further', 'get', 'had', 'has', 'have', 'having', 'here', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'make', 'more', 'most', 'need', 'new',
  'no', 'not', 'now', 'of', 'off', 'on', 'once', 'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'please', 'same', 'see', 'set', 'should', 'so',
  'some', 'still', 'such', 'task', 'tasks', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'todo', 'too', 'under', 'until', 'up', 'update', 'use', 'very', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why',
  'will', 'with', 'would', 'you', 'your',
]
