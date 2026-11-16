// Scripts of the live demos next to the Features stories, each
// showing what its text says. Data is made up and neutral.
import type { DemoScript } from './demoScript'

/* -------------------------------------------------- 1.1 Conversation · terminal
   The grouped tool calls unfold,
   the proposed command is copied then run: the view flips to the live
   terminal, the tests run, and it comes back to the conversation. */
export const CONVERSATION: DemoScript = {
  id: 'conversation',
  // 1 group open · 2–4 the reply is read · 5 copied · 6 run
  // · 7 terminal + typing · 8 test lines · 9 summary · 10 back to the conversation
  timeline: [[1100, 1], [2500, 2], [3300, 3], [4000, 4], [5000, 5], [6300, 6], [6900, 7], [8000, 8], [9000, 9], [11200, 10]],
  loop: 13500,
  final: 5,
  typing: { step: 7, text: 'npm test', ms: 600 },
}
/** Claude's calls, with the app's labels and icons (ChatView.vue TOOL_LABEL / TOOL_ICON); more than three are grouped. */
export const CONVERSATION_TOOLS = [
  { icon: 'i-lucide-file-text', tool: 'Read', arg: 'package.json' },
  { icon: 'i-lucide-file-plus', tool: 'Write', arg: '~/projects/web-shop/src/cart.js' },
  { icon: 'i-lucide-file-plus', tool: 'Write', arg: '~/projects/web-shop/src/cart.test.js' },
  { icon: 'i-lucide-terminal', tool: 'Command', arg: 'Run the cart tests' },
] as const
export const TEST_OUTPUT = [
  'ok 1 - addToCart adds an item to the cart',
  'ok 2 - removeFromCart removes an item by id',
  'ok 3 - cartTotal sums price times quantity',
] as const

/* ------------------------------------------------------- 1.2 Phone · notifications
   An agent needs you: a push lands on the lock screen with the question and
   its options; on the agent list, the answer is one tap on the card, and the
   agent goes back to work, then is done (second push). */
export const PHONE: DemoScript = {
  id: 'phone',
  // 1 your turn + push · 2 option tapped · 3 sent, working · 4 action · 5 done + push
  timeline: [[1200, 1], [3800, 2], [4400, 3], [5600, 4], [7600, 5]],
  loop: 10500,
  final: 3,
}
