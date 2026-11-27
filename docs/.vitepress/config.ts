import { defineConfig } from 'vitepress'

const base = process.env.BASE_URL || '/'

export default defineConfig({
  title: 'Nodal AI',
  description: 'Modular, secure Stellar Agent Kit with PayFi / x402 support',
  lang: 'en-US',
  
  base,

  // TypeDoc's finished HTML site is published as static files, not compiled as pages.
  srcExclude: ['public/**'],
  
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
            { text: 'Tools System', link: '/guide/tools' },
            { text: 'MCP Server', link: '/guide/mcp' }
          ]
        },
        {
          text: 'AI & Automation',
          items: [
            { text: 'AI Payment Safety', link: '/guide/ai-safety' },
            { text: 'Planning & Confirmation', link: '/guide/planning' },
            { text: 'Triggers', link: '/guide/triggers' },
            { text: 'Approvals', link: '/guide/approvals' },
            { text: 'Tutorial: MCP Client', link: '/tutorials/mcp-client' },
            { text: 'Tutorial: Escrow Trigger', link: '/tutorials/trigger-escrow-release' }
          ]
        },
        {
          text: 'PayFi & x402',
          items: [
            { text: 'Payment Standard', link: '/guide/payfi' },
            { text: 'MPP Payments', link: '/guide/mpp' },
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
