export class CullStats extends HTMLElement {
  constructor() {
    super()
    const shadowRoot = this.attachShadow({ mode: 'open' })

    this.div = document.createElement('div')
    this.div.classList.add('cull-stats')
    shadowRoot.appendChild(this.div)

    const styleTag = document.createElement('style')
    styleTag.appendChild(
      document.createTextNode(`
      .cull-stats {
        position: absolute;
        bottom: 10px;
        left: 10px;
        color: #000000;
      }
    `)
    )
    shadowRoot.appendChild(styleTag)
  }

  set renderer(renderer) {
    renderer.on('CullingUpdated', (event) => {
      this.div.textContent = `visible: ${event.visible} / total: ${event.total}`
    })
  }
}

customElements.define('cull-stats', CullStats)
