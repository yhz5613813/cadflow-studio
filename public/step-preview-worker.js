/* Local, separately replaceable OCCT WebAssembly importer. See vendor/occt licenses. */
self.onmessage = async ({ data }) => {
  try {
    if (!(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength > 128 * 1024 * 1024) throw new Error('STEP 文件不能超过 128 MB');
    self.postMessage({ type: 'progress', text: '正在启动 STEP 解析器…' });
    importScripts('/vendor/occt/occt-import-js.js');
    const occt = await occtimportjs({ locateFile: name => '/vendor/occt/' + name, print: () => {}, printErr: () => {} });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data.buffer)), n => n.toString(16).padStart(2, '0')).join('');
    const qualities = { draft: 0.004, standard: 0.001, fine: 0.00025 };
    const quality = Object.hasOwn(qualities, data.quality) ? data.quality : 'standard';
    self.postMessage({ type: 'progress', text: '正在读取 STEP 并生成预览网格…' });
    const result = occt.ReadStepFile(new Uint8Array(data.buffer), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: qualities[quality], angularDeflection: 0.35 });
    if (!result.success || !result.meshes?.length) throw new Error('STEP 中没有可显示的面，或文件无法解析');
    const triangleCount = result.meshes.reduce((sum, mesh) => sum + mesh.index.array.length / 3, 0);
    if (result.meshes.length > 20000 || triangleCount > 3000000) throw new Error('预览超过 20000 个网格或 300 万三角面，请选择快速精度或拆分模型');
    const transfers = [];
    for (const mesh of result.meshes) {
      mesh.attributes.position.array = new Float32Array(mesh.attributes.position.array);
      mesh.index.array = new Uint32Array(mesh.index.array);
      transfers.push(mesh.attributes.position.array.buffer, mesh.index.array.buffer);
      if (mesh.attributes.normal) { mesh.attributes.normal.array = new Float32Array(mesh.attributes.normal.array); transfers.push(mesh.attributes.normal.array.buffer); }
    }
    self.postMessage({ type: 'result', result, hash, quality }, transfers);
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'STEP 解析失败，请检查文件或降低预览精度' }); }
};
