<script setup lang="ts">
// Shared keyboard shortcut reference: those of the table
// (utils/shortcuts.ts) and those a component owns, grouped by place.
const mac = /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent)
const ARROWS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown']
type Group = { title: string, rows: { label: string, keys: string[][], v2?: true }[] }
// herdr-core (v3): the rows marked v2 (tabs, editor, swap) are not offered yet.
const allGroups: Group[] = [
  { title: tl('Anywhere', 'Partout'), rows: [
    { label: tl('Search agents and conversations', 'Rechercher agents et conversations'), keys: [shortcutKbds('search-all')] },
    { label: tl('Previous / next agent in the list', 'Agent précédent / suivant de la liste'), keys: [shortcutKbds('prev-agent'), shortcutKbds('next-agent')] },
    { label: tl('Previous / next tab of this space', 'Onglet précédent / suivant de cet espace'), keys: [shortcutKbds('prev-tab'), shortcutKbds('next-tab')] },
    { label: tl('New agent, in a new space', 'Nouvel agent, dans un nouvel espace'), keys: [shortcutKbds('new-space')] },
    { label: tl('New tab in this space', 'Nouvel onglet dans cet espace'), keys: [shortcutKbds('new-tab')], v2: true },
    { label: tl('Close this pane', 'Fermer ce pane'), keys: [shortcutKbds('close-pane')] },
    { label: tl('Current agent folder in the editor', 'Dossier de l’agent dans l’éditeur'), keys: [shortcutKbds('open-editor')], v2: true },
    { label: t('Settings'), keys: [shortcutKbds('settings')] },
    { label: tl('Keyboard shortcuts', 'Raccourcis clavier'), keys: [shortcutKbds('help'), ['?']] },
  ] },
  { title: tl('Agent', 'Agent'), rows: [
    { label: tl('Search this conversation', 'Rechercher dans la conversation'), keys: [shortcutKbds('search-chat')] },
    { label: tl('Conversation / terminal', 'Conversation / terminal'), keys: [shortcutKbds('toggle-term')] },
    { label: tl('Stop the agent (twice, empty field)', 'Arrêter l’agent (deux fois, champ vide)'), keys: [[...shortcutKbds('stop'), ...shortcutKbds('stop')]] },
    { label: tl('Send / new line', 'Envoyer / nouvelle ligne'), keys: [['enter'], ['shift', 'enter']] },
    { label: tl('Previous / next sent text (first / last line)', 'Texte envoyé précédent / suivant (première / dernière ligne)'), keys: [['arrowup'], ['arrowdown']] },
    { label: tl('Use Claude’s suggestion', 'Prendre la suggestion de Claude'), keys: [['tab']] },
  ] },
  { title: tl('Side by side', 'Côte à côte'), rows: [
    { label: tl('Focus the neighbouring pane', 'Passer au pane voisin'), keys: [['meta', 'alt', ...ARROWS]] },
    { label: tl('Swap with the neighbouring pane', 'Échanger avec le pane voisin'), keys: [['alt', 'shift', ...ARROWS]], v2: true },
  ] },
  { title: tl('“Your turn” card', 'Carte « À toi »'), rows: [
    { label: tl('Choose an option', 'Choisir une option'), keys: [['1–9']] },
    { label: tl('Move, confirm, cancel', 'Déplacer, valider, annuler'), keys: [['arrowup', 'arrowdown', 'enter', 'escape']] },
  ] },
  { title: tl('Terminal', 'Terminal'), rows: [
    { label: tl('Copy the selection', 'Copier la sélection'), keys: [mac ? ['meta', 'C'] : ['ctrl', 'shift', 'C']] },
    { label: tl('New line for the agent', 'Nouvelle ligne pour l’agent'), keys: [['shift', 'enter']] },
  ] },
]
const groups = allGroups.map(g => ({ ...g, rows: g.rows.filter(r => !r.v2) }))
</script>

<template>
  <div class="shortcuts-reference">
    <section v-for="g in groups" :key="g.title" class="settings-group shortcuts-group">
      <h3>{{ g.title }}</h3>
      <dl>
        <div v-for="r in g.rows" :key="r.label" class="shortcut-row">
          <dt>{{ r.label }}</dt>
          <dd>
            <template v-for="(combo, i) in r.keys" :key="i">
              <span v-if="i" class="sep">/</span>
              <UKbd v-for="k in combo" :key="k" :value="k" />
            </template>
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>
