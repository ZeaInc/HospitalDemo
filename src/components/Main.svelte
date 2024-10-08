<script>
  import { onMount } from 'svelte'

  import '../helpers/fps-display'
  import '../helpers/cull-stats'
  import '../helpers/vr-ui'

  import Menu from '../components/ContextMenu/Menu.svelte'
  import MenuOption from '../components/ContextMenu/MenuOption.svelte'
  import Dialog from '../components/Dialog.svelte'
  import ParameterOwnerWidget from './parameters/ParameterOwnerWidget.svelte'
  import Toolbar from '../components/Toolbar/Toolbar.svelte'

  import Drawer from '../components/Drawer.svelte'
  import ProgressBar from '../components/ProgressBar.svelte'
  import Sidebar from '../components/Sidebar.svelte'
  import DropZone from '../components/DropZone.svelte'

  import { auth } from '../helpers/auth'

  import { APP_DATA } from '../stores/appData'
  import { assets } from '../stores/assets.js'
  import { ui } from '../stores/ui.js'
  import { selectionManager } from '../stores/selectionManager.js'
  import { scene } from '../stores/scene.js'

  import { createClient } from '../ChannelMessenger.js'
  import buildTree from '../helpers/buildTree'
  import loadProductStructure from '../helpers/loadProductStructure'

  const {
    Color,
    Vec3,
    Xfo,
    TreeItem,
    GLRenderer,
    Scene,
    resourceLoader,
    SystemDesc,
    EnvMap,
    InstanceItem,
    CameraManipulator,
    GeomItem,
  } = window.zeaEngine
  const { CADAsset, CADBody } = window.zeaCad
  const {
    SelectionManager,
    UndoRedoManager,
    ToolManager,
    SelectionTool,
    VRUITool,
    VRHoldObjectsTool,
    CreateFreehandLineTool,
    CreateSphereTool,
    CreateCuboidTool,
    CreateConeTool,
    ParameterValueChange,
  } = window.zeaUx

  const { Session, SessionSync } = window.zeaCollab
  const { GLTFAsset } = gltfLoader

  let canvas
  let fpsContainer
  const urlParams = new URLSearchParams(window.location.search)
  const embeddedMode = urlParams.has('embedded')
  const collabEnabled = urlParams.has('roomId')
  let progress
  let files = ''
  let fileLoaded = false
  const appData = {}
  let renderer

  const filterItemSelection = (item) => {
    // Propagate selections up from the edges and surfaces up to
    // the part body or the instanced body
    const srcItem = item
    while (
      item &&
      !(item instanceof CADBody) &&
      !(item instanceof InstanceItem && item.getSrcTree() instanceof CADBody)
    ) {
      item = item.getOwner()
    }
    return item ? item : srcItem
  }

  /** LOAD ASSETS METHODS START */
  const loadZCADAsset = (url, filename) => {
    const asset = new CADAsset()
    asset.load(url).then(() => {
      renderer.frameAll()
    })
    $assets.addChild(asset)
    return asset
  }

  const loadGLTFAsset = (url, filename) => {
    const asset = new GLTFAsset()
    asset.load(url, filename).then(() => {
      renderer.frameAll()
    })
    $assets.addChild(asset)
    return asset
  }

  const loadAsset = (url, filename) => {
    let res
    if (filename.endsWith('zcad')) {
      res = loadZCADAsset(url, filename)
    } else if (filename.endsWith('gltf') || filename.endsWith('glb')) {
      res = loadGLTFAsset(url, filename)
    } else if (filename.endsWith('json')) {
      loadProductStructure(url, filename).then((root) => {
        $assets.addChild(root)
      })
    }

    if (res) fileLoaded = true
    return res
  }
  /** LOAD ASSETS METHODS END */

  onMount(async () => {
    renderer = new GLRenderer(canvas, {
      debugGeomIds: urlParams.has('debugGeomIds'),
      enableFrustumCulling: true,
      enableOcclusionCulling: false,
      outlineThickness: 0,
      outlineSensitivity: 0.5,
      outlineColor: new Color(0.2, 0.2, 0.2, 1),
    })

    $scene = new Scene()

    // Assigning an Environment Map enables PBR lighting for niceer shiny surfaces.
    if (!SystemDesc.isMobileDevice && SystemDesc.gpuDesc.supportsWebGL2) {
      const envMap = new EnvMap('envMap')
      envMap.getParameter('FilePath').setValue('data/StudioG.zenv')
      envMap.getParameter('HeadLightMode').setValue(true)
      $scene.getSettings().getParameter('EnvMap').setValue(envMap)
    }

    renderer
      .getViewport()
      .getCamera()
      .setPositionAndTarget(new Vec3(-80, -40, 20), new Vec3(40, 80, 10))
    // $scene.setupGrid(10, 10)
    $scene
      .getSettings()
      .getParameter('BackgroundColor')
      .setValue(new Color(0.85, 0.85, 0.85, 1))
    renderer.setScene($scene)

    appData.renderer = renderer
    appData.scene = $scene

    $assets = new TreeItem('Assets')
    appData.assets = $assets

    $scene.getRoot().addChild($assets)

    /** UNDO START */
    const undoRedoManager = UndoRedoManager.getInstance()
    appData.undoRedoManager = undoRedoManager
    /** UNDO END */

    /** SELECTION START */
    const cameraManipulator = renderer.getViewport().getManipulator()
    cameraManipulator.setDefaultManipulationMode(
      CameraManipulator.MANIPULATION_MODES.turntable
    )
    appData.cameraManipulator = cameraManipulator
    const toolManager = new ToolManager(appData)
    $selectionManager = new SelectionManager(appData, {
      enableXfoHandles: true,
    })

    // Users can enable the handles usinga menu or hotkey.
    $selectionManager.showHandles(false)

    appData.selectionManager = $selectionManager

    const selectionTool = new SelectionTool(appData)
    selectionTool.setSelectionFilter(filterItemSelection)
    toolManager.registerTool('SelectionTool', selectionTool)
    toolManager.registerTool('CameraManipulator', cameraManipulator)

    renderer.getViewport().setManipulator(toolManager)
    toolManager.pushTool('CameraManipulator')
    appData.toolManager = toolManager

    // Note: the alpha value determines  the fill of the highlight.
    const selectionColor = new Color('#F9CE03')
    selectionColor.a = 0.1
    const subtreeColor = selectionColor //.lerp(new Color(1, 1, 1, 0), 0.5)
    $selectionManager.selectionGroup
      .getParameter('HighlightColor')
      .setValue(selectionColor)
    $selectionManager.selectionGroup
      .getParameter('SubtreeHighlightColor')
      .setValue(subtreeColor)

    // Color the selection rect.
    const selectionRectColor = new Color(0, 0, 0, 1)
    selectionTool.rectItem
      .getParameter('Material')
      .getValue()
      .getParameter('BaseColor')
      .setValue(selectionRectColor)

    /** SELECTION END */

    /** UX START */
    //long touch support
    var longTouchTimer = 0
    const camera = renderer.getViewport().getCamera()
    const startLongTouchTimer = (event, item) => {
      longTouchTimer = setTimeout(function () {
        //long touch for any click but we can specifify
        openMenu(event, item)
        longTouchTimer = 0
        camera.getParameter('GlobalXfo').off('valueChanged', endLogTouchTimer)
      }, 1000)
      camera.getParameter('GlobalXfo').on('valueChanged', endLogTouchTimer)
    }
    const endLogTouchTimer = () => {
      clearTimeout(longTouchTimer)
      longTouchTimer = 0
      camera.getParameter('GlobalXfo').off('valueChanged', endLogTouchTimer)
    }

    renderer.getViewport().on('pointerDown', (event) => {
      if (isMenuVisible) closeMenu()
      if (event.intersectionData && event.pointerType == 'mouse') {
        const { geomItem } = event.intersectionData
        console.log(geomItem.getPath())
        const material = geomItem.getParameter('Material').getValue()
        console.log(material.getName(), material.getShaderName())
      }
      if (event.pointerType == 'touch' && event.intersectionData) {
        const item = filterItemSelection(event.intersectionData.geomItem)
        startLongTouchTimer(event, item)
      }
    })

    renderer.getViewport().on('pointerUp', (event) => {
      // Clear any pending long touch.
      if (longTouchTimer) {
        endLogTouchTimer(longTouchTimer)
      }
      if (
        event.pointerType == 'touch' &&
        event.intersectionData &&
        isMenuVisible
      ) {
        // The menu was opened by the long touch. Prevent any other actions from occuring.
        event.stopPropagation()
      }

      // Detect a right click
      if (event.button == 0 && event.intersectionData) {
        // if the selection tool is active then do nothing, as it will
        // handle single click selection.s
        const toolStack = toolManager.toolStack
        if (toolStack[toolStack.length - 1] == selectionTool) return

        // To provide a simple selection when the SelectionTool is not activated,
        // we toggle selection on the item that is selcted.
        // const item = filterItemSelection(event.intersectionData.geomItem)
        // if (item) {
        //   if (!event.shiftKey) {
        //     $selectionManager.toggleItemSelection(item, !event.ctrlKey)
        //   } else {
        //     const items = new Set()
        //     items.add(item)
        //     $selectionManager.deselectItems(items)
        //   }
        // }
      } else if (event.button == 2 && event.intersectionData) {
        const item = filterItemSelection(event.intersectionData.geomItem)
        openMenu(event, item)
        // stop propagation to prevent the camera manipulator from handling the event.
        event.stopPropagation()
      }
    })

    renderer.getViewport().on('pointerDoublePressed', (event) => {
      console.log(event)
    })
    /** UX END */

    /** PROGRESSBAR START */
    resourceLoader.on('progressIncremented', (event) => {
      progress = event.percent
    })
    /** PROGRESSBAR END */

    /** FPS DISPLAY START */
    const fpsDisplay = document.createElement('fps-display')
    fpsDisplay.renderer = renderer
    fpsContainer.appendChild(fpsDisplay)

    const cullStats = document.createElement('cull-stats')
    cullStats.renderer = renderer
    fpsContainer.appendChild(cullStats)

    console.log('perfTest:', urlParams.has('perfTest'))
    if (urlParams.has('perfTest')) {
      renderer.startContinuousDrawing()
    }
    /** FPS DISPLAY END */

    /** LOAD ASSETS START */
    if (!embeddedMode) {
      if (urlParams.has('zcad')) {
        const assetUrl = urlParams.get('zcad')
        loadAsset(assetUrl, assetUrl)
        fileLoaded = true
      } else if (urlParams.has('gltf')) {
        const assetUrl = urlParams.get('gltf')
        loadAsset(assetUrl, assetUrl)
        fileLoaded = true
      } else {
        let assetUrl = 'data/Hospital/site-struct.json'
        if (urlParams.has('prdStruct')) assetUrl = urlParams.get('prdStruct')
        loadProductStructure(assetUrl, assetUrl).then((root) => {
          $assets.addChild(root)
          root.on('loaded', (event) => {
            console.log('Done:', event.InstanceName)
            if (event.name == 'Architectural') {
              const asset = event.treeItem
              const Ribs = asset.resolvePath([
                'Architectural',
                'Assembly_0',
                'Default',
                'Instance_0',
                'Level 1',
                'Option 2 - Ribs Faceted:Option 2 - Ribs Faceted:187261',
              ])
              if (Ribs) {
                Ribs.setVisible(false)
              }

              ;[
                ['Level 3', 'Stair:7" max riser 11" tread:187507:2'],
                ['Level 4', 'Stair:7" max riser 11" tread:187507:3'],
                ['Level 3', 'Stair:7" max riser 11" tread:189108:2'],
                ['Level 4', 'Stair:7" max riser 11" tread:189108:3'],
                ['Level 3', 'Stair:7" max riser 11" tread:190846:2'],
                ['Level 3', 'Stair:7" max riser 11" tread:195889:2'],
                ['Level 4', 'Stair:7" max riser 11" tread:195889:3'],
                ['Level 5', 'Stair:7" max riser 11" tread:195889:4'],
                ['Level 3', 'Stair:7" max riser 11" tread:190278:2'],
                ['Level 4', 'Stair:7" max riser 11" tread:190278:3'],
                ['Level 3', 'Stair:7" max riser 11" tread:189710:2'],
                ['Level 4', 'Stair:7" max riser 11" tread:189710:3'],
                ['Level 5', 'Stair:7" max riser 11" tread:189710:4'],
                [
                  'Level 1',
                  'Stair:7" max riser 11" tread - no stringer:196518',
                ],
              ].forEach((subpath) => {
                const path = [
                  'Architectural',
                  'Assembly_0',
                  'Default',
                  'Instance_0',
                  subpath[0],
                  subpath[1],
                ]
                const Stairs = asset.resolvePath(path)
                if (Stairs) {
                  Stairs.setVisible(false)
                }
              })

              const materials = asset.getMaterialLibrary()
              const windows = materials.getMaterial('Body_0002')
              {
                var color = windows.getParameter('BaseColor').getValue()
                color.a = 0.3
                windows.getParameter('BaseColor').setValue(color)
              }
              const greyWindows = materials.getMaterial('Body_0007')
              {
                var color = greyWindows.getParameter('BaseColor').getValue()
                color.a = 0.5
                greyWindows.getParameter('BaseColor').setValue(color)
              }
            }
          })
        })
        fileLoaded = true
      }
    }
    /** LOAD ASSETS END */
    fileLoaded = true

    /** COLLAB START*/
    if (!embeddedMode) {
      const userData = await auth.getUserData()
      if (!userData) {
        return
      }
      appData.userData = userData

      if (collabEnabled) {
        const SOCKET_URL = 'https://websocket-staging.zea.live'
        const roomId = urlParams.get('roomId')
        const session = new Session(userData, SOCKET_URL)
        if (roomId) session.joinRoom(roomId)

        const sessionSync = new SessionSync(session, appData, userData, {
          /* Avatars scale based on the distance to the target */
          scaleAvatarWithFocalDistance: true,
          /* The overal size multiplier of the avatar. */
          avatarScale: 2.0,
        })

        appData.session = session
        appData.sessionSync = sessionSync

        appData.session.sub('loadAsset', (data, user) => {
          loadAsset(data.url, data.filename)
        })

        APP_DATA.update(() => appData)
      }
    }
    /** COLLAB END */

    /** EMBED MESSAGING START*/
    if (embeddedMode) {
      const client = createClient()

      client.on('setBackgroundColor', (data) => {
        const color = new Color(data.color)
        $scene.getSettings().getParameter('BackgroundColor').setValue(color)

        if (data._id) {
          client.send(data._id, { done: true })
        }
      })

      client.on('loadCADFile', (data) => {
        console.log('loadCADFile', data)
        if (!data.keep) {
          $assets.removeAllChildren()
        }

        const asset = loadAsset(data.url, data.filename)
        asset.once('loaded', () => {
          if (data._id) {
            const tree = buildTree(asset)
            client.send(data._id, { modelStructure: tree })
          }
        })
      })

      client.on('getModelStructure', (data) => {
        if (data._id) {
          const tree = buildTree($assets)
          client.send(data._id, { modelStructure: tree })
        }
      })

      client.on('unloadCADFile', (data) => {
        console.log('unloadCADFile', data)

        $assets.removeChildByName(data.name)

        if (data._id) {
          client.send(data._id, { done: true })
        }
      })

      $selectionManager.on('selectionChanged', (event) => {
        const { selection } = event
        const selectionPaths = []
        selection.forEach((item) =>
          selectionPaths.push(item.getPath().slice(2))
        )
        client.send('selectionChanged', { selection: selectionPaths })
      })
    }
    /** EMBED MESSAGING END */

    /** DYNAMIC SELECTION UI START */
    $selectionManager.on('leadSelectionChanged', (event) => {
      parameterOwner = event.treeItem
      $ui.shouldShowParameterOwnerWidget = parameterOwner
    })
    /** DYNAMIC SELECTION UI END */

    /** VR TOOLS SETUP START */
    const holdObjectsTool = new VRHoldObjectsTool(appData)
    const freehandLineTool = new CreateFreehandLineTool(appData)
    const createSphereTool = new CreateSphereTool(appData)
    const createCuboidTool = new CreateCuboidTool(appData)
    const createConeTool = new CreateConeTool(appData)
    const vrToolManager = new ToolManager(appData)

    // Register both tools.
    vrToolManager.registerTool('VRHoldObjectsTool', holdObjectsTool)
    vrToolManager.registerTool('Create Cuboid', createCuboidTool)
    vrToolManager.registerTool('Create Sphere', createSphereTool)
    vrToolManager.registerTool('Create Cone', createConeTool)
    vrToolManager.registerTool('Freehand Line Tool', freehandLineTool)

    const vrUIDOMElement = document.createElement('vr-ui')

    vrUIDOMElement.setRenderer(renderer)
    vrUIDOMElement.setToolManager(vrToolManager)

    document.body.appendChild(vrUIDOMElement)
    const vrUITool = new VRUITool(appData, vrUIDOMElement.contentDiv)
    vrToolManager.registerTool('VRUITool', vrUITool)
    // vrUITool.controllerUI.activate()

    renderer.getXRViewport().then((xrViewport) => {
      const viewManipulator = xrViewport.getManipulator()

      vrToolManager.registerTool('VRViewManipulator', viewManipulator)
      xrViewport.setManipulator(vrToolManager)
      vrToolManager.pushTool('VRViewManipulator')
      vrToolManager.pushTool('VRUITool')
    })
    /** VR TOOLS SETUP END */

    APP_DATA.set(appData)
  })

  let isMenuVisible = false
  let pos = { x: 0, y: 0 }
  let contextItem
  const openMenu = (event, item) => {
    contextItem = item
    pos = event.touches
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
      : { x: event.clientX, y: event.clientY }
    isMenuVisible = true
  }
  const closeMenu = () => {
    isMenuVisible = false
  }
  let isDialogOpen = false
  const closeDialog = () => {
    isDialogOpen = false
  }

  /** LOAD ASSETS FROM FILE START */

  const handleCadFile = () => {
    const reader = new FileReader()

    reader.addEventListener(
      'load',
      function () {
        const url = reader.result
        const filename = files.name
        loadAsset(url, filename)

        // If a collabroative session is running, pass the data
        // to the other session users to load.
        const { session } = appData
        if (session) session.pub('loadAsset', { url, filename })
      },
      false
    )

    reader.readAsDataURL(files)
  }

  const handleDrop = () => {
    console.log('test')
  }

  /** LOAD ASSETS FROM FILE END */

  $: parameterOwner = null
</script>

<main class="Main flex-1 relative">
  <canvas bind:this={canvas} class="absolute h-full w-full" />
  {#if !fileLoaded}
    <DropZone bind:files on:changeFile={handleCadFile} />
  {/if}

  <div class="absolute bottom-10 w-full flex justify-center">
    <Toolbar />
  </div>

  <div bind:this={fpsContainer} />

  <Drawer>
    <Sidebar />
  </Drawer>

  {#if $ui.shouldShowParameterOwnerWidget}
    <ParameterOwnerWidget {parameterOwner} />
  {/if}
</main>

{#if progress < 100}
  <div class="fixed bottom-0 w-full">
    <ProgressBar {progress} />
  </div>
{/if}

<Dialog isOpen={isDialogOpen} close={closeDialog} {contextItem} />

{#if isMenuVisible}
  <Menu {...pos} on:click={closeMenu} on:clickoutside={closeMenu}>
    <MenuOption
      text="Hide"
      on:click={() => {
        const visibleParam = contextItem.getParameter('Visible')

        const change = new ParameterValueChange(visibleParam, false)

        const undoRedoManager = UndoRedoManager.getInstance()
        undoRedoManager.addChange(change)

        // contextItem.getParameter('Visible').setValue(false)
      }}
    />
    <MenuOption
      text="Properties"
      on:click={() => {
        if (contextItem) {
          isDialogOpen = true
          closeMenu()
        }
      }}
    />
  </Menu>
{/if}

<style>
  canvas {
    touch-action: none;
  }
</style>
