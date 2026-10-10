export default function registerApplication(plugin) {
  plugin.registerContribution('application', 'status', {
    label: '本地应用示例',
    title: '本地应用示例',
    chrome: 'host',
    icon: { type: 'builtin', name: 'plugin' },
    load: () => import('./application.js').then((module) => module.default)
  })
}
