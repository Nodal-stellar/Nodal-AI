import { defineConfig } from 'vitepress'

const base = process.env.BASE_URL || '/'

export default defineConfig({
  title: 'Nodal AI',
  description: 'Modular, secure Stellar Agent Kit with PayFi / x402 support',
  lang: 'en-US',
  
  base,
  
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'API Reference', link: '/guide/api-reference' },
      { text: 'Design', link: '/guide/design' }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Why Nodal AI?', link: '/guide/why' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' }
          ]
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Agent Configuration', link: '/guide/agent-config' },
            { text: 'Tools System', link: '/guide/tools' }
          ]
        },
        {
          text: 'PayFi & x402',
          items: [
            { text: 'Payment Standard', link: '/guide/payfi' },
            { text: 'Security Model', link: '/guide/security' }
          ]
        },
        {
          text: 'API',
          items: [
            { text: 'API Reference', link: '/guide/api-reference' }
          ]
        },
        {
          text: 'Design',
          items: [
            { text: 'On-Chain Policy', link: '/guide/design' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/your-org/nodal-ai' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Nodal AI'
    }
  }
})
