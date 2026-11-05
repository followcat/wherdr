// The board: each project's columns and every task's card.
import { board } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'

export default defineApi(() => board(pmStore()))
