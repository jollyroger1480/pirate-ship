/* Storm layer for Skull Island Cove — the Island Zero read:
   charcoal sky, steel-blue chop, mist at every shoreline, warm practicals.
   Everything here is cheap: sprites, points, and a handful of props.
   createStormFX(THREE, scene, opts) -> { update(t, dt, camera, ship), attachShip(root) }
   opts.mist / glows / rain / torches / lanternLights default true; false skips
   that layer (a daylight scene turns the night layers off). */
export function createStormFX(THREE, scene, opts = {}) {
  const heightAt = opts.heightAt || (() => 0);
  const islands = opts.islands || [];
  const anchors = opts.anchors || [];
  const wantMist = opts.mist !== false;
  const wantGlows = opts.glows !== false;
  const wantRain = opts.rain !== false;
  const wantTorches = opts.torches !== false;
  const wantLanternLight = opts.lanternLights !== false;
  const rand = (a, b) => a + Math.random() * (b - a);

  function canvasTexture(size, draw) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    draw(c.getContext("2d"), size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ---------- soft round sprite (mist, glow, spray) ---------- */
  const puffTex = canvasTexture(128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, "rgba(255,255,255,0.85)");
    r.addColorStop(0.45, "rgba(255,255,255,0.32)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  const flameTex = canvasTexture(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s * 0.62, 2, s / 2, s * 0.55, s * 0.5);
    r.addColorStop(0, "rgba(255,240,200,1)");
    r.addColorStop(0.35, "rgba(255,170,70,0.9)");
    r.addColorStop(0.7, "rgba(200,70,20,0.35)");
    r.addColorStop(1, "rgba(120,30,10,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });

  /* ---------- shoreline mist ---------- */
  const mists = [];
  const beaconGlows = [];
  const mistGroup = new THREE.Group();
  const mistSpots = [];
  for (const isl of islands) {
    const r = Math.max(isl.shelfRadius || 0, isl.radius || 120);
    const n = Math.min(7, Math.max(2, Math.round(r / 130)));
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const d = r * rand(0.55, 1.15);
      mistSpots.push({ x: isl.x + Math.cos(a) * d, z: isl.z + Math.sin(a) * d, s: rand(50, 130) });
    }
  }
  for (const an of anchors) mistSpots.push({ x: an.x, z: an.z, s: rand(40, 80) });
  for (const spot of mistSpots.slice(0, 46)) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: puffTex, color: 0x9fb2bd, transparent: true,
      opacity: rand(0.18, 0.3), depthWrite: false,
    }));
    m.position.set(spot.x, rand(2, 9), spot.z);
    m.scale.set(spot.s * 1.5, spot.s * rand(0.42, 0.6), 1);
    m.userData = { baseX: spot.x, baseZ: spot.z, ph: rand(0, 9), sp: rand(0.008, 0.02), os: spot.s };
    mistGroup.add(m);
    mists.push(m);
  }
  mistGroup.visible = wantMist;
  scene.add(mistGroup);

  /* ---------- beacon glows: warm halos on every island light ---------- */
  for (const isl of islands) {
    if (!isl.beacon) continue;
    const big = isl.id === "skull-island";
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: puffTex,
      color: isl.id === "skull-island" ? 0xd8541e : 0xffb45e,
      transparent: true, opacity: big ? 0.34 : 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.position.set(isl.x + isl.beacon[0], isl.beacon[2] + 6, isl.z + isl.beacon[1]);
    const gs = big ? 70 : 46;
    glow.scale.set(gs, gs * 0.8, 1);
    glow.userData = { ph: rand(0, 9), base: big ? 0.34 : 0.3 };
    glow.visible = wantGlows;
    scene.add(glow);
    beaconGlows.push(glow);
  }

  /* ---------- rain: line streaks falling around the camera ---------- */
  const RAIN_N = 550;
  const rainPos = new Float32Array(RAIN_N * 6); // two verts per drop
  const rainVel = new Float32Array(RAIN_N);
  const RAIN_LEN = 1.5;
  function seedRain(i, cy) {
    const x = rand(-70, 70), y = cy + rand(0, 45), z = rand(-70, 70);
    rainPos[i * 6] = x; rainPos[i * 6 + 1] = y; rainPos[i * 6 + 2] = z;
    rainPos[i * 6 + 3] = x + 0.35; rainPos[i * 6 + 4] = y - RAIN_LEN; rainPos[i * 6 + 5] = z + 0.12;
    rainVel[i] = rand(38, 62);
  }
  for (let i = 0; i < RAIN_N; i++) seedRain(i, 0);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
    color: 0xaec2ce, transparent: true, opacity: 0.55,
    depthWrite: false,
  }));
  rain.frustumCulled = false;
  rain.visible = wantRain;
  scene.add(rain);

  /* ---------- bow spray particles ---------- */
  const SPRAY_N = 260;
  const sprayPos = new Float32Array(SPRAY_N * 3);
  const sprayCol = new Float32Array(SPRAY_N * 3);
  const sprayVel = new Float32Array(SPRAY_N * 3);
  const sprayLife = new Float32Array(SPRAY_N);
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
  sprayGeo.setAttribute("color", new THREE.BufferAttribute(sprayCol, 3));
  const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({
    size: 0.5, vertexColors: true, transparent: true, opacity: 0.75,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  spray.frustumCulled = false;
  scene.add(spray);
  let sprayCursor = 0;
  function emitSpray(x, y, z, dx, dz, speed) {
    const n = Math.min(4, 1 + Math.floor(speed / 18));
    for (let k = 0; k < n; k++) {
      const i = sprayCursor = (sprayCursor + 1) % SPRAY_N;
      sprayPos[i * 3] = x + rand(-2.5, 2.5);
      sprayPos[i * 3 + 1] = y + rand(0, 1.2);
      sprayPos[i * 3 + 2] = z + rand(-2.5, 2.5);
      sprayVel[i * 3] = dx * speed * 0.35 + rand(-2, 2);
      sprayVel[i * 3 + 1] = rand(2.5, 6.5);
      sprayVel[i * 3 + 2] = dz * speed * 0.35 + rand(-2, 2);
      sprayLife[i] = rand(0.5, 1.1);
      sprayCol[i * 3] = 0.75; sprayCol[i * 3 + 1] = 0.85; sprayCol[i * 3 + 2] = 0.9;
    }
  }

  /* ---------- beach props: torches, crates, barrels, dock, boulders ---------- */
  const woodTex = new THREE.TextureLoader().load("beach/tex-wood.png");
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
  woodTex.colorSpace = THREE.SRGBColorSpace;
  const rockTex = new THREE.TextureLoader().load("beach/tex-rock.png");
  rockTex.wrapS = rockTex.wrapT = THREE.RepeatWrapping;
  rockTex.colorSpace = THREE.SRGBColorSpace;

  const props = new THREE.Group();
  const torchLights = [];
  const torchFlames = [];
  const torchMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 });
  const woodMat = new THREE.MeshStandardMaterial({
    map: woodTex, color: 0x9a7c5c, roughness: 0.85, envMapIntensity: 0.2,
  });
  const darkWoodMat = new THREE.MeshStandardMaterial({
    map: woodTex, color: 0x5c4a38, roughness: 0.9, envMapIntensity: 0.15,
  });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.5, metalness: 0.8 });
  const rockMat = new THREE.MeshStandardMaterial({
    map: rockTex, color: 0x6a7076, roughness: 0.6, envMapIntensity: 0.35,
  });

  function groundY(x, z) { return heightAt(x, z); }

  function addTorch(x, z, yaw) {
    const y = groundY(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = yaw || 0;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 2.4, 6), torchMat);
    pole.position.y = 1.2;
    pole.castShadow = true;
    g.add(pole);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.08, 0.22, 8), ironMat);
    cup.position.y = 2.45;
    g.add(cup);
    const flame = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flameTex, color: 0xffc27a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    flame.position.y = 2.75;
    flame.scale.set(0.8, 1.25, 1);
    g.add(flame);
    torchFlames.push({ sprite: flame, ph: rand(0, 9) });
    const li = new THREE.PointLight(0xff8a3c, 60, 32, 2);
    li.position.y = 2.8;
    g.add(li);
    torchLights.push({ light: li, ph: rand(0, 9), base: 60 });
    // an invisible group takes its flame sprite and point light with it
    g.visible = wantTorches;
    props.add(g);
  }

  function addCrate(x, z, s, ry) {
    const y = groundY(x, z);
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.82, s), woodMat);
    m.position.set(x, y + s * 0.41, z);
    m.rotation.y = ry || rand(0, 3);
    m.castShadow = m.receiveShadow = true;
    props.add(m);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(s * 1.02, s * 0.1, s * 1.02), ironMat);
    edge.position.set(x, y + s * 0.75, z);
    edge.rotation.y = m.rotation.y;
    props.add(edge);
  }

  function addBarrel(x, z, ry) {
    const y = groundY(x, z);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.05, 12), darkWoodMat);
    m.position.set(x, y + 0.52, z);
    m.rotation.y = ry || 0;
    m.castShadow = m.receiveShadow = true;
    props.add(m);
    for (const hy of [0.25, 0.8]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 14), ironMat);
      band.rotation.x = Math.PI / 2;
      band.position.set(x, y + hy, z);
      props.add(band);
    }
  }

  function addBoulder(x, z, s) {
    const y = groundY(x, z);
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
    m.position.set(x, y + s * 0.35, z);
    m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    m.scale.y = 0.72;
    m.castShadow = m.receiveShadow = true;
    props.add(m);
  }

  // Spawn beach dressing — the cove where the ship starts (x~10, z~528).
  addTorch(-14, 540, 0.6);
  addTorch(34, 552, -0.9);
  addTorch(58, 536, 2.2);
  addCrate(-22, 548, 1.15, 0.4);
  addCrate(-20.5, 549.5, 0.9, 1.1);
  addCrate(40, 546, 1.0, 0.2);
  addBarrel(44, 549, 0.5);
  addBarrel(-18, 552, 1.4);
  addBoulder(-52, 556, 1.6);
  addBoulder(84, 560, 2.2);
  addBoulder(96, 544, 1.3);
  // A short plank dock reaching into the cove.
  const dock = new THREE.Group();
  const dockY = groundY(70, 528);
  for (let i = 0; i < 7; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 1.5), woodMat);
    plank.position.set(70 + i * 2.35, dockY + 0.35 + Math.sin(i) * 0.05, 528);
    plank.castShadow = plank.receiveShadow = true;
    dock.add(plank);
  }
  for (const px of [70.5, 82.5]) {
    for (const pz of [526.6, 529.4]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.4, 8), darkWoodMat);
      post.position.set(px, dockY - 0.4, pz);
      dock.add(post);
    }
  }
  props.add(dock);
  scene.add(props);

  /* ---------- ship lanterns (attached to hull) ---------- */
  const lanterns = [];
  function lanternMesh(x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.18, 6), ironMat);
    cap.position.y = 0.62;
    g.add(cap);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
    );
    g.add(core);
    if (wantLanternLight) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flameTex, color: 0xffb45e, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
      }));
      glow.scale.set(2.4, 2.4, 1);
      g.add(glow);
      lanterns.push({ glow, ph: rand(0, 9) });
    }
    return g;
  }
  function attachShip(root) {
    // ship-local: +z is the bow, the hull is +-2.6 m wide, the stern at z -10.3
    const spots = [
      [0, 9.5, 7.5], [-2.4, 5.2, -3], [2.4, 5.2, -3], [0, 7.6, -10.1],
    ];
    for (const [x, y, z] of spots) root.add(lanternMesh(x, y, z));
    if (!wantLanternLight) return;
    const fore = new THREE.PointLight(0xffb45e, 95, 60, 2);
    fore.position.set(0, 10.5, 8);
    const aft = new THREE.PointLight(0xff9a4a, 80, 55, 2);
    aft.position.set(0, 8.2, -10);
    root.add(fore, aft);
    lanterns.push({ light: fore, ph: 1.3, base: 95 }, { light: aft, ph: 4.1, base: 80 });
  }

  /* ---------- per-frame ---------- */
  const camCenter = new THREE.Vector3();
  function update(t, dt, camera, ship) {
    if (mistGroup.visible) {
      for (const m of mists) {
        const u = m.userData;
        m.position.x = u.baseX + Math.sin(t * u.sp + u.ph) * 14;
        m.position.z = u.baseZ + Math.cos(t * u.sp * 0.8 + u.ph) * 14;
        m.position.y = 3 + Math.sin(t * 0.05 + u.ph) * 2;
        m.material.opacity = 0.16 + 0.11 * (0.5 + 0.5 * Math.sin(t * 0.07 + u.ph * 2));
      }
    }
    camera.getWorldPosition(camCenter);
    const cx = camCenter.x, cy = camCenter.y, cz = camCenter.z;
    if (rain.visible) {
      const rp = rainGeo.attributes.position.array;
      for (let i = 0; i < RAIN_N; i++) {
        const o = i * 6;
        let y = rp[o + 1] - rainVel[i] * dt;
        if (y < cy - 8) { seedRain(i, cy + 40); }
        rp[o] += cx - camCenter.x; rp[o + 1] = y; rp[o + 2] += cz - camCenter.z;
        rp[o + 3] += cx - camCenter.x; rp[o + 4] = y - RAIN_LEN; rp[o + 5] += cz - camCenter.z;
        if (rp[o] - cx > 70) { rp[o] -= 140; rp[o + 3] -= 140; }
        else if (rp[o] - cx < -70) { rp[o] += 140; rp[o + 3] += 140; }
        if (rp[o + 2] - cz > 70) { rp[o + 2] -= 140; rp[o + 5] -= 140; }
        else if (rp[o + 2] - cz < -70) { rp[o + 2] += 140; rp[o + 5] += 140; }
      }
      rainGeo.attributes.position.needsUpdate = true;
    }
    if (ship) {
      const speed = ship.userData.speed || 0;
      if (speed > 4) {
        const b = ship.userData.bow || { x: Math.sin(ship.rotation.y), z: Math.cos(ship.rotation.y) };
        emitSpray(
          ship.position.x - b.x * 11, ship.position.y + 1.5, ship.position.z - b.z * 11,
          -b.x, -b.z, speed
        );
      }
    }
    for (let i = 0; i < SPRAY_N; i++) {
      if (sprayLife[i] <= 0) { sprayCol[i * 3] = sprayCol[i * 3 + 1] = sprayCol[i * 3 + 2] = 0; continue; }
      sprayLife[i] -= dt;
      sprayVel[i * 3 + 1] -= 9.8 * dt;
      sprayPos[i * 3] += sprayVel[i * 3] * dt;
      sprayPos[i * 3 + 1] += sprayVel[i * 3 + 1] * dt;
      sprayPos[i * 3 + 2] += sprayVel[i * 3 + 2] * dt;
      const f = Math.max(0, sprayLife[i]);
      sprayCol[i * 3] = 0.75 * f; sprayCol[i * 3 + 1] = 0.85 * f; sprayCol[i * 3 + 2] = 0.9 * f;
    }
    sprayGeo.attributes.position.needsUpdate = true;
    sprayGeo.attributes.color.needsUpdate = true;
    if (wantTorches) {
      for (const fl of torchFlames) {
        const s = 0.5 + 0.18 * Math.sin(t * 11 + fl.ph) + 0.1 * Math.sin(t * 23 + fl.ph * 2);
        fl.sprite.scale.set(1.1 * s, 1.7 * s, 1);
      }
      for (const tl of torchLights) {
        tl.light.intensity = tl.base * (0.82 + 0.18 * Math.sin(t * 13 + tl.ph) + 0.08 * Math.sin(t * 29 + tl.ph));
      }
    }
    if (wantGlows) {
      for (const bg of beaconGlows) {
        bg.material.opacity = bg.userData.base * (0.75 + 0.25 * Math.sin(t * 2.2 + bg.userData.ph));
      }
    }
    for (const ln of lanterns) {
      if (ln.light) ln.light.intensity = ln.base * (0.85 + 0.15 * Math.sin(t * 9 + ln.ph));
      else if (ln.glow) ln.glow.material.opacity = 0.7 + 0.2 * Math.sin(t * 10 + ln.ph);
    }
  }

  return { update, attachShip };
}
