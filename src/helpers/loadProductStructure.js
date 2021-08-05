const { Color, Vec3, Xfo, Mat4, TreeItem, resourceLoader } = window.zeaEngine
const { CADAsset } = window.zeaCad

function checkStatus(response) {
  if (!response.ok) {
    return false
  }

  return response
}

export default async function loadProductStructure(url, filename) {
  const folder =
    url.lastIndexOf('/') > -1
      ? url.substring(0, url.lastIndexOf('/')) + '/'
      : ''

  const stem = filename.substring(0, filename.lastIndexOf('.'))
  const promisses = []
  const references = {}

  const parseReferenceList = (json) => {
    json.forEach((refJson) => parseReference(refJson))
  }
  const loadReference = (reference) => {
    return new Promise((resolve, reject) => {
      reference.asset.load(reference.url).then(
        () => {
          const materials = reference.asset.getMaterialLibrary().getMaterials()
          materials.forEach((material) => {
            if (material.getShaderName() == 'StandardSurfaceShader') {
              material.setShaderName('SimpleSurfaceShader')
              const baseColorParam = material.getParameter('BaseColor')
              if (baseColorParam) {
                baseColorParam.setValue(baseColorParam.getValue().toGamma())
              }
            }
          })
          resolve()
        },
        () => {
          reject()
        }
      )
    })
  }
  const parseReference = (json) => {
    const asset = new CADAsset()
    const url = folder + json.url
    references[json.Name] = {
      Name: json.Name,
      url,
      asset: asset,
      refs: 0, // Now many times this asset has been referenced in the tree.
    }
  }
  const parseTreeItem = (json) => {
    let treeItem
    // If this item references an asset we loaded earlier, then we use/clone the asset
    if (json.Reference in references) {
      const reference = references[json.Reference]
      const asset = reference.asset
      if (reference.refs == 0) {
        loadReference(reference).then(() => {
          root.emit('loaded', {
            treeItem,
            ReferenceName: reference.Name,
            name: json.InstanceName,
          })
        })
        treeItem = asset
      } else {
        // After the first reference, we clone.
        // Note: this is a shallow clone and all the geometry data will be shared(instanced)
        treeItem = asset.clone()

        root.emit('loaded', {
          treeItem,
          ReferenceName: reference.Name,
          name: json.InstanceName,
        })
      }
      treeItem.setName(json.InstanceName)
      reference.refs++
    } else {
      treeItem = new TreeItem(json.Name)
    }

    const xfo = new Xfo()
    if (json.matrix) {
      const mat4 = new Mat4()
      const d = json.matrix
      // mat4.set(d[0], d[1], d[2], 1, d[3], d[4], d[5], 1, d[6], d[7], d[8], 1, d[9], d[10], d[11], 1)
      mat4.set(
        d[0],
        d[1],
        d[2],
        d[3],
        d[4],
        d[5],
        d[6],
        d[7],
        d[8],
        d[9],
        d[10],
        d[11],
        0,
        0,
        0,
        0
      )
      mat4.transposeInPlace()
      xfo.setFromMat4(mat4)
    } else if (json.xfo) {
      xfo.fromJSON(json.xfo)
    }
    treeItem.getParameter('LocalXfo').setValue(xfo)
    if (json.children) {
      json.children.forEach((childJson) => {
        const child = parseTreeItem(childJson)
        treeItem.addChild(child, false) // << false to keep the local xfo
      })
    }
    return treeItem
  }

  resourceLoader.incrementWorkload(2) // load and parse
  const response = await fetch(url)
  resourceLoader.incrementWorkDone(1) // load complete
  if (!checkStatus(response))
    throw new Error(
      `Unable to load Product Structure: ${url}. ${response.status} - ${response.statusText}`
    )
  const json = await response.json()

  parseReferenceList(json['Reference List'])

  const root = parseTreeItem(json['Root'])

  Promise.all(promisses).then(() => {
    resourceLoader.incrementWorkDone(1) // parse complete
  })

  return root
}
