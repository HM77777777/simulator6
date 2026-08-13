(() => {
  "use strict";

  const VERSION = "1.0.0";
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const ATLAS_SIZE = 900;
  const BASE_JOINT = Object.freeze({ x: 493, y: 548 });
  const BASE_INCISOR = Object.freeze({ x: 792, y: 735 });
  const MAIN_PX_PER_MM = 3.2;

  const DEFAULT_JOINT = Object.freeze({
    sagittalInclinationDeg: 35,
    linkEminenceToGuidance: true,
    eminenceHeightMm: 8.4,
    eminenceLengthMm: 12,
    fossaDepthMm: 4.2,
    posteriorWallDeg: 18,
    condyleShape: "oval",
    condyleAPMm: 18,
    condyleHeightMm: 9,
    condyleMLMm: 21,
    condyleFlatteningPct: 0,
    bennettDeg: 15,
    immediateSideShiftMm: 0.5,
    progressiveSideShiftMmPerMm: 0.08,
    discAnteriorMm: 2.6,
    discIntermediateMm: 1.1,
    discPosteriorMm: 3.0,
    discLengthMm: 17,
    discDisplacementMm: 0,
    discDeformationPct: 0,
    discMobilityPct: 82,
    discReduction: true,
    discReductionThresholdMm: 3.2,
    discRotationDeg: 0,
    superiorJointSpaceMm: 2.2,
    retrodiscalElasticityPct: 72,
    capsuleLaxityPct: 45,
    jointOffsetXMm: 0,
    jointOffsetYMm: 0,
  });

  const DEFAULT_STATE = Object.freeze({
    version: VERSION,
    selectedSide: "right",
    motion: {
      openingMm: 0,
      protrusionMm: 0,
      lateralMm: 0,
      autoTranslation: true,
      useIncisalGuidance: true,
      animationSpeed: 1,
    },
    guidance: {
      incisalSagittalDeg: 35,
      incisalLateralDeg: 25,
    },
    patient: {
      skullAPPct: 100,
      skullVerticalPct: 100,
      mandibleLengthPct: 100,
      ramusHeightPct: 100,
      intercondylarMm: 110,
      hingeIncisorMm: 100,
      occlusalPitchDeg: 8,
    },
    joints: {
      right: { ...DEFAULT_JOINT },
      left: { ...DEFAULT_JOINT },
    },
    display: {
      layout: "split",
      xrayMode: false,
      cutaway: true,
      showBaseline: true,
      showLabels: true,
      showPlanes: true,
      showPaths: true,
      showGrid: true,
      focusTarget: "all",
      layers: {
        cranium: { visible: true, opacity: 1 },
        temporal: { visible: true, opacity: 0.96 },
        mandible: { visible: true, opacity: 0.96 },
        condyle: { visible: true, opacity: 1 },
        disc: { visible: true, opacity: 1 },
        softTissue: { visible: true, opacity: 0.7 },
        paths: { visible: true, opacity: 0.9 },
      },
    },
  });

  let state = deepClone(DEFAULT_STATE);
  const animation = {
    playing: false,
    kind: "protrusive",
    progress: 0,
    durationSeconds: 4,
    startedAt: 0,
    startProgress: 0,
    raf: 0,
  };

  const view = {
    skull: { centerX: 450, centerY: 455, zoom: 1, panX: 0, panY: 0 },
    joint: { zoom: 1, panX: 0, panY: 0 },
  };

  const assetPaths = window.TMJ_ASSETS || {
    cranium: "assets/cranium-lateral.png",
    mandible: "assets/mandible-body-lateral.png",
    lowerTeeth: "assets/lower-teeth-lateral.png",
    fullSkull: "assets/skull-full-alpha.png",
    ghost: "assets/skull-ghost-lateral.png",
  };

  const images = {};
  let assetsReady = false;
  let renderQueued = false;
  let toastTimer = 0;

  const dom = {};

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function easeInOut(t) {
    return 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
  }

  function getPath(object, path) {
    return path.split(".").reduce((current, key) => current?.[key], object);
  }

  function setPath(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((current, key) => current[key], object);
    target[last] = value;
  }

  function mergeWithDefaults(defaultValue, candidate) {
    if (Array.isArray(defaultValue)) return Array.isArray(candidate) ? candidate.slice() : defaultValue.slice();
    if (defaultValue && typeof defaultValue === "object") {
      const out = {};
      for (const [key, value] of Object.entries(defaultValue)) {
        out[key] = mergeWithDefaults(value, candidate && typeof candidate === "object" ? candidate[key] : undefined);
      }
      return out;
    }
    return candidate === undefined || candidate === null ? defaultValue : candidate;
  }

  function selectedJoint() {
    return state.joints[state.selectedSide];
  }

  function effectiveEminenceHeight(joint) {
    if (!joint.linkEminenceToGuidance) return joint.eminenceHeightMm;
    return clamp(Math.tan(joint.sagittalInclinationDeg * DEG) * joint.eminenceLengthMm, 0, 36);
  }

  function morphologyAngle(joint) {
    return Math.atan2(effectiveEminenceHeight(joint), Math.max(0.1, joint.eminenceLengthMm)) * RAD;
  }

  function sagittalLateralProjectionAngle(joint) {
    return Math.atan2(Math.tan(joint.sagittalInclinationDeg * DEG), Math.cos(joint.bennettDeg * DEG)) * RAD;
  }

  function roofY(joint, xMm, useBaseline = false) {
    const j = useBaseline ? { ...DEFAULT_JOINT } : joint;
    const height = useBaseline ? effectiveEminenceHeight(DEFAULT_JOINT) : effectiveEminenceHeight(j);
    const roofBase = -(j.condyleHeightMm / 2 + j.discIntermediateMm + j.superiorJointSpaceMm);
    if (xMm <= 0) {
      const posteriorLimit = -20;
      const t = clamp((xMm - posteriorLimit) / (0 - posteriorLimit), 0, 1);
      const concavity = Math.sin(Math.PI * t);
      const posteriorRise = (1 - t) * Math.tan(j.posteriorWallDeg * DEG) * 3.2;
      return roofBase + 1.6 - j.fossaDepthMm * concavity + posteriorRise;
    }
    const length = Math.max(0.1, j.eminenceLengthMm);
    const s = clamp(xMm / length, 0, 1);
    const curved = s * s * (3 - 2 * s);
    const after = Math.max(0, xMm - length);
    return roofBase + 1.6 + height * curved + after * Math.tan(morphologyAngle(j) * DEG) * 0.18;
  }

  function condylarPathDrop(joint, distanceMm) {
    if (distanceMm <= 0) return 0;
    const angle = joint.sagittalInclinationDeg * DEG;
    const length = Math.max(1, joint.eminenceLengthMm);
    const s = clamp(distanceMm / length, 0, 1);
    const curvatureFactor = lerp(0.68, 1, smoothstep(0, 1, s));
    const within = Math.min(distanceMm, length) * Math.tan(angle) * curvatureFactor;
    const after = Math.max(0, distanceMm - length) * Math.tan(angle) * 0.45;
    return within + after;
  }

  function condylarPathTangent(joint, distanceMm) {
    const h = 0.05;
    const y0 = condylarPathDrop(joint, Math.max(0, distanceMm - h));
    const y1 = condylarPathDrop(joint, distanceMm + h);
    return Math.atan2(y1 - y0, 2 * h);
  }

  function workingRelation(side, lateralMm) {
    if (Math.abs(lateralMm) < 0.02) return "centric";
    const excursion = lateralMm > 0 ? "left" : "right";
    return side === excursion ? "working" : "nonworking";
  }

  function computeKinematics(side = state.selectedSide, motionOverride = null) {
    const joint = state.joints[side];
    const motion = motionOverride ? { ...state.motion, ...motionOverride } : state.motion;
    const opening = clamp(Number(motion.openingMm) || 0, 0, 60);
    const protrusion = clamp(Number(motion.protrusionMm) || 0, 0, 20);
    const lateral = clamp(Number(motion.lateralMm) || 0, -20, 20);
    const hingeRadius = Math.max(60, state.patient.hingeIncisorMm);
    const openingRotation = 2 * Math.asin(clamp(opening / (2 * hingeRadius), -0.999, 0.999));
    const openTranslation = motion.autoTranslation
      ? (opening <= 12 ? opening * 0.03 : 0.36 + (opening - 12) * 0.16)
      : 0;

    const relation = workingRelation(side, lateral);
    let lateralAnterior = 0;
    let mediolateral = 0;
    if (relation === "nonworking") {
      lateralAnterior = Math.abs(lateral) * 0.64;
      mediolateral = joint.immediateSideShiftMm * smoothstep(0, 2, Math.abs(lateral))
        + lateralAnterior * Math.tan(joint.bennettDeg * DEG);
    } else if (relation === "working") {
      lateralAnterior = Math.abs(lateral) * 0.08;
      mediolateral = -(joint.immediateSideShiftMm * 0.35 + Math.abs(lateral) * joint.progressiveSideShiftMmPerMm);
    }

    const anteriorMm = protrusion + openTranslation + lateralAnterior;
    const dropMm = condylarPathDrop(joint, anteriorMm);
    const tangentRad = condylarPathTangent(joint, anteriorMm);

    let guidanceRotation = 0;
    if (motion.useIncisalGuidance) {
      const desiredSagittalDrop = protrusion * Math.tan(state.guidance.incisalSagittalDeg * DEG);
      const desiredLateralDrop = Math.abs(lateral) * 0.24 * Math.tan(state.guidance.incisalLateralDeg * DEG);
      const condylarSagittalDrop = condylarPathDrop(joint, protrusion + lateralAnterior * 0.45);
      guidanceRotation = clamp((desiredSagittalDrop + desiredLateralDrop - condylarSagittalDrop) / hingeRadius, -9 * DEG, 9 * DEG);
    }

    const totalRotationRad = openingRotation + guidanceRotation;
    const baseCenter = {
      x: BASE_JOINT.x + joint.jointOffsetXMm * MAIN_PX_PER_MM,
      y: BASE_JOINT.y + joint.jointOffsetYMm * MAIN_PX_PER_MM,
    };
    const condyleCenter = {
      x: baseCenter.x + anteriorMm * MAIN_PX_PER_MM,
      y: baseCenter.y + dropMm * MAIN_PX_PER_MM,
    };

    let reductionProgress = 0;
    if (joint.discReduction && joint.discDisplacementMm > 0) {
      reductionProgress = smoothstep(
        joint.discReductionThresholdMm,
        joint.discReductionThresholdMm + 3.5,
        anteriorMm + opening * 0.035,
      ) * (joint.discMobilityPct / 100);
    }
    const effectiveDiscOffsetMm = joint.discDisplacementMm * (1 - reductionProgress);
    const discFollower = joint.discMobilityPct / 100;
    const discForwardMm = anteriorMm * lerp(0.42, 0.96, discFollower) + effectiveDiscOffsetMm;
    const discPathDropMm = condylarPathDrop(joint, Math.max(0, discForwardMm));
    const condyleTopY = condyleCenter.y - joint.condyleHeightMm * MAIN_PX_PER_MM / 2;
    const discCenter = {
      x: baseCenter.x + discForwardMm * MAIN_PX_PER_MM,
      y: condyleTopY - (joint.discIntermediateMm * 0.48 + 0.25) * MAIN_PX_PER_MM
        + (discPathDropMm - dropMm) * MAIN_PX_PER_MM * 0.22,
    };
    const discAngleRad = condylarPathTangent(joint, Math.max(0, discForwardMm))
      + joint.discRotationDeg * DEG * (1 - reductionProgress * 0.55);

    const jawScaleX = state.patient.mandibleLengthPct / 100;
    const jawScaleY = state.patient.ramusHeightPct / 100;
    const incisorPoint = transformJawPoint(BASE_INCISOR, baseCenter, condyleCenter, totalRotationRad, jawScaleX, jawScaleY);

    const morphAngle = morphologyAngle(joint);
    const mismatchDeg = Math.abs(joint.sagittalInclinationDeg - morphAngle);
    const geometricClearance = joint.superiorJointSpaceMm
      - Math.max(0, (joint.condyleHeightMm - DEFAULT_JOINT.condyleHeightMm) / 2)
      - Math.max(0, joint.discIntermediateMm - DEFAULT_JOINT.discIntermediateMm) * 0.55
      - mismatchDeg * 0.025;

    return {
      side,
      joint,
      motion,
      relation,
      openingRotation,
      guidanceRotation,
      totalRotationRad,
      anteriorMm,
      dropMm,
      mediolateralMm: mediolateral,
      tangentRad,
      baseCenter,
      condyleCenter,
      discCenter,
      discAngleRad,
      discForwardMm,
      effectiveDiscOffsetMm,
      reductionProgress,
      incisorPoint,
      morphAngle,
      mismatchDeg,
      clearanceMm: geometricClearance,
    };
  }

  function transformJawPoint(point, baseCenter, newCenter, rotation, scaleX, scaleY) {
    const dx = (point.x - BASE_JOINT.x) * scaleX;
    const dy = (point.y - BASE_JOINT.y) * scaleY;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      x: newCenter.x + cos * dx - sin * dy,
      y: newCenter.y + sin * dx + cos * dy,
    };
  }

  function discRelationText(k) {
    const original = k.joint.discDisplacementMm;
    const current = k.effectiveDiscOffsetMm;
    if (original > 1) {
      if (k.joint.discReduction && k.reductionProgress > 0.82 && current < 1) return "前方位から復位した状態（モデル）";
      if (k.joint.discReduction && k.reductionProgress > 0.05) return "前方位・復位過程（モデル）";
      return k.joint.discReduction ? "前方位・復位前（モデル）" : "前方位・復位なし（モデル）";
    }
    if (original < -1) return "後方位（モデル）";
    if (Math.abs(current) <= 1) return "整位に近い配置（モデル）";
    return "軽度の位置偏位（モデル）";
  }

  function phaseText() {
    const { openingMm, protrusionMm, lateralMm } = state.motion;
    if (Math.abs(lateralMm) > 0.05) return lateralMm > 0 ? "左側方運動" : "右側方運動";
    if (protrusionMm > 0.05) return "前方運動";
    if (openingMm > 0.05) return "開口運動";
    return "中心位";
  }

  function getLayerAlpha(name) {
    const layer = state.display.layers[name];
    if (!layer?.visible) return 0;
    let alpha = layer.opacity;
    const target = state.display.focusTarget;
    if (target === "all") return alpha;
    const emphasis = {
      tmj: { cranium: 0.46, temporal: 1, mandible: 0.58, condyle: 1, disc: 1, softTissue: 1, paths: 1 },
      eminence: { cranium: 0.2, temporal: 1, mandible: 0.2, condyle: 0.55, disc: 0.35, softTissue: 0.3, paths: 0.72 },
      condyle: { cranium: 0.15, temporal: 0.42, mandible: 0.32, condyle: 1, disc: 0.48, softTissue: 0.42, paths: 0.65 },
      disc: { cranium: 0.12, temporal: 0.36, mandible: 0.2, condyle: 0.58, disc: 1, softTissue: 0.72, paths: 0.55 },
      mandible: { cranium: 0.24, temporal: 0.36, mandible: 1, condyle: 1, disc: 0.35, softTissue: 0.28, paths: 0.52 },
    };
    return alpha * (emphasis[target]?.[name] ?? 1);
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`画像を読み込めませんでした: ${String(source).slice(0, 80)}`));
      image.src = source;
    });
  }

  async function loadAssets() {
    const entries = Object.entries(assetPaths);
    const loaded = await Promise.all(entries.map(async ([key, source]) => [key, await loadImage(source)]));
    for (const [key, image] of loaded) images[key] = image;
    assetsReady = true;
  }

  function prepareCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height, dpr };
  }

  function deformedPoint(point) {
    const sx = state.patient.skullAPPct / 100;
    const sy = state.patient.skullVerticalPct / 100;
    return {
      x: 450 + (point.x - 450) * sx,
      y: 450 + (point.y - 450) * sy,
    };
  }

  function displayedPoint(point) {
    const p = deformedPoint(point);
    return state.selectedSide === "left" ? { x: ATLAS_SIZE - p.x, y: p.y } : p;
  }

  function skullTransform(width, height) {
    const center = displayedPoint({ x: view.skull.centerX, y: view.skull.centerY });
    const scale = Math.min(width / ATLAS_SIZE, height / ATLAS_SIZE) * 0.97 * view.skull.zoom;
    return {
      scale,
      tx: width / 2 + view.skull.panX - center.x * scale,
      ty: height / 2 + view.skull.panY - center.y * scale,
      width,
      height,
    };
  }

  function sourceToSkullScreen(point, transform) {
    const p = displayedPoint(point);
    return { x: transform.tx + p.x * transform.scale, y: transform.ty + p.y * transform.scale };
  }

  function applySkullAnatomyTransform(ctx, transform) {
    ctx.translate(transform.tx, transform.ty);
    ctx.scale(transform.scale, transform.scale);
    if (state.selectedSide === "left") {
      ctx.translate(ATLAS_SIZE, 0);
      ctx.scale(-1, 1);
    }
    ctx.translate(450, 450);
    ctx.scale(state.patient.skullAPPct / 100, state.patient.skullVerticalPct / 100);
    ctx.translate(-450, -450);
  }

  function drawSkull() {
    const { ctx, width, height } = prepareCanvas(dom.skullCanvas);
    drawCanvasBackground(ctx, width, height, "skull");
    if (!assetsReady) {
      drawLoading(ctx, width, height);
      return;
    }

    const k = computeKinematics();
    const joint = k.joint;
    const tr = skullTransform(width, height);
    const constantLine = 1 / Math.max(0.001, tr.scale);

    ctx.save();
    applySkullAnatomyTransform(ctx, tr);

    if (state.display.xrayMode) {
      ctx.save();
      ctx.globalAlpha = 0.52 * getLayerAlpha("cranium");
      ctx.globalCompositeOperation = "screen";
      ctx.drawImage(images.ghost, 0, 0, ATLAS_SIZE, ATLAS_SIZE);
      ctx.restore();
    }

    const craniumAlpha = getLayerAlpha("cranium") * (state.display.xrayMode ? 0.32 : 0.96);
    if (craniumAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = craniumAlpha;
      if (state.display.xrayMode) ctx.globalCompositeOperation = "screen";
      ctx.drawImage(images.cranium, 0, 0, ATLAS_SIZE, ATLAS_SIZE);
      ctx.restore();
    }

    if (state.display.showBaseline) drawBaselineJointMain(ctx, k, constantLine);
    if (state.display.showPaths && getLayerAlpha("paths") > 0) drawMotionPathsMain(ctx, k, constantLine);
    if (getLayerAlpha("temporal") > 0) drawTemporalPatchMain(ctx, k, constantLine);
    if (getLayerAlpha("softTissue") > 0) drawSoftTissuesMain(ctx, k, constantLine);
    if (getLayerAlpha("mandible") > 0) drawMandibleMain(ctx, k);
    if (getLayerAlpha("condyle") > 0) drawCondyleMain(ctx, k, constantLine);
    if (getLayerAlpha("disc") > 0) drawDiscMain(ctx, k, constantLine);
    if (state.display.showPlanes) drawPlanesMain(ctx, k, constantLine);
    drawCurrentMarkersMain(ctx, k, constantLine);

    ctx.restore();

    if (state.display.showLabels) drawSkullLabels(ctx, tr, k, width, height);
    drawSkullHud(ctx, tr, k, width, height);
  }

  function drawCanvasBackground(ctx, width, height, kind) {
    const gradient = ctx.createRadialGradient(width * 0.52, height * 0.48, 15, width * 0.52, height * 0.48, Math.max(width, height) * 0.7);
    if (kind === "joint") {
      gradient.addColorStop(0, "#19364e");
      gradient.addColorStop(0.55, "#0d2232");
      gradient.addColorStop(1, "#07141f");
    } else {
      gradient.addColorStop(0, "#1a3142");
      gradient.addColorStop(0.58, "#0d1e2b");
      gradient.addColorStop(1, "#07131d");
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "rgba(125, 167, 194, .14)";
    ctx.lineWidth = 1;
    const step = kind === "joint" ? 32 : 40;
    for (let x = step / 2; x < width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = step / 2; y < height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawLoading(ctx, width, height) {
    ctx.fillStyle = "rgba(231,245,252,.78)";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("解剖レイヤーを読み込み中…", width / 2, height / 2);
  }

  function drawMandibleMain(ctx, k) {
    const alpha = getLayerAlpha("mandible");
    const scaleX = state.patient.mandibleLengthPct / 100;
    const scaleY = state.patient.ramusHeightPct / 100;
    ctx.save();
    ctx.translate(k.condyleCenter.x, k.condyleCenter.y);
    ctx.rotate(k.totalRotationRad);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-BASE_JOINT.x, -BASE_JOINT.y);
    ctx.globalAlpha = alpha;
    if (state.display.xrayMode) ctx.globalAlpha *= 0.64;
    ctx.drawImage(images.mandible, 0, 0, ATLAS_SIZE, ATLAS_SIZE);
    ctx.drawImage(images.lowerTeeth, 0, 0, ATLAS_SIZE, ATLAS_SIZE);
    ctx.restore();
  }

  function makeCondylePath(ctx, joint, pxPerMm) {
    const width = joint.condyleAPMm * pxPerMm;
    const baseHeight = joint.condyleHeightMm * pxPerMm;
    const flatten = joint.condyleFlatteningPct / 100;
    const height = baseHeight * (1 - flatten * 0.36);
    const halfW = width / 2;
    const halfH = height / 2;
    ctx.beginPath();
    switch (joint.condyleShape) {
      case "round": {
        const r = Math.min(halfW, halfH * 1.12);
        ctx.ellipse(0, 0, r, r * (1 - flatten * 0.18), 0, 0, Math.PI * 2);
        break;
      }
      case "flat":
        ctx.moveTo(-halfW, 2);
        ctx.bezierCurveTo(-halfW * 0.86, -halfH * 0.55, -halfW * 0.45, -halfH * 0.76, -halfW * 0.18, -halfH * 0.78);
        ctx.lineTo(halfW * 0.42, -halfH * 0.78);
        ctx.bezierCurveTo(halfW * 0.8, -halfH * 0.68, halfW, -halfH * 0.24, halfW, 1);
        ctx.bezierCurveTo(halfW * 0.9, halfH * 0.82, halfW * 0.25, halfH, 0, halfH);
        ctx.bezierCurveTo(-halfW * 0.58, halfH, -halfW, halfH * 0.55, -halfW, 2);
        ctx.closePath();
        break;
      case "beak":
        ctx.moveTo(-halfW, 1);
        ctx.bezierCurveTo(-halfW * 0.86, -halfH * 0.8, -halfW * 0.25, -halfH, halfW * 0.26, -halfH * 0.72);
        ctx.quadraticCurveTo(halfW * 0.72, -halfH * 0.5, halfW * 1.1, -halfH * 0.08);
        ctx.quadraticCurveTo(halfW * 0.76, halfH * 0.18, halfW * 0.62, halfH * 0.48);
        ctx.bezierCurveTo(halfW * 0.28, halfH, -halfW * 0.55, halfH, -halfW, 1);
        ctx.closePath();
        break;
      case "asymmetric":
        ctx.moveTo(-halfW * 1.05, 1);
        ctx.bezierCurveTo(-halfW, -halfH * 0.7, -halfW * 0.35, -halfH * 1.05, halfW * 0.28, -halfH * 0.68);
        ctx.bezierCurveTo(halfW * 0.92, -halfH * 0.3, halfW, halfH * 0.15, halfW * 0.72, halfH * 0.6);
        ctx.bezierCurveTo(halfW * 0.22, halfH * 1.02, -halfW * 0.65, halfH * 0.92, -halfW * 1.05, 1);
        ctx.closePath();
        break;
      default:
        ctx.ellipse(0, 0, halfW, halfH, 0, 0, Math.PI * 2);
    }
  }

  function drawCondyleMain(ctx, k, constantLine) {
    const joint = k.joint;
    const alpha = getLayerAlpha("condyle");
    ctx.save();
    ctx.translate(k.condyleCenter.x, k.condyleCenter.y);
    ctx.rotate(k.totalRotationRad * 0.28 + k.tangentRad * 0.12);
    makeCondylePath(ctx, joint, MAIN_PX_PER_MM);
    const gradient = ctx.createLinearGradient(-20, -18, 24, 24);
    gradient.addColorStop(0, "rgba(255,250,237,.98)");
    gradient.addColorStop(0.45, "rgba(222,209,182,.98)");
    gradient.addColorStop(1, "rgba(150,133,105,.98)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.lineWidth = 1.25 * constantLine;
    ctx.strokeStyle = "rgba(92,76,54,.82)";
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.5;
    ctx.beginPath();
    ctx.ellipse(-joint.condyleAPMm * MAIN_PX_PER_MM * 0.12, -joint.condyleHeightMm * MAIN_PX_PER_MM * 0.16, joint.condyleAPMm * MAIN_PX_PER_MM * 0.31, joint.condyleHeightMm * MAIN_PX_PER_MM * 0.22, -0.15, Math.PI, Math.PI * 1.9);
    ctx.strokeStyle = "rgba(255,255,255,.78)";
    ctx.lineWidth = 0.8 * constantLine;
    ctx.stroke();
    ctx.restore();
  }

  function drawDiscPath(ctx, joint, pxPerMm, deformationScale = 1) {
    const length = joint.discLengthMm * pxPerMm;
    const half = length / 2;
    const deformation = joint.discDeformationPct / 100;
    const samples = 34;
    const upper = [];
    const lower = [];
    const thicknessAt = (u) => {
      const posteriorBand = Math.exp(-Math.pow((u + 0.42) / 0.25, 2));
      const anteriorBand = Math.exp(-Math.pow((u - 0.42) / 0.25, 2));
      const middle = Math.exp(-Math.pow(u / 0.32, 2));
      const value = joint.discIntermediateMm
        + (joint.discPosteriorMm - joint.discIntermediateMm) * posteriorBand
        + (joint.discAnteriorMm - joint.discIntermediateMm) * anteriorBand
        - joint.discIntermediateMm * 0.16 * middle * deformation;
      return Math.max(0.25, value) * pxPerMm * deformationScale;
    };
    for (let i = 0; i <= samples; i += 1) {
      const u = -1 + (i / samples) * 2;
      const x = u * half;
      const taper = Math.pow(Math.max(0, 1 - Math.abs(u)), 0.18);
      const centerCurve = -Math.cos(u * Math.PI) * joint.discIntermediateMm * pxPerMm * 0.12
        + deformation * Math.abs(u) * pxPerMm * 0.35;
      const t = thicknessAt(u) * taper;
      upper.push({ x, y: centerCurve - t / 2 });
      lower.push({ x, y: centerCurve + t / 2 });
    }
    ctx.beginPath();
    ctx.moveTo(upper[0].x, upper[0].y);
    for (let i = 1; i < upper.length; i += 1) ctx.lineTo(upper[i].x, upper[i].y);
    for (let i = lower.length - 1; i >= 0; i -= 1) ctx.lineTo(lower[i].x, lower[i].y);
    ctx.closePath();
  }

  function drawDiscMain(ctx, k, constantLine) {
    const alpha = getLayerAlpha("disc");
    ctx.save();
    ctx.translate(k.discCenter.x, k.discCenter.y);
    ctx.rotate(k.discAngleRad);
    drawDiscPath(ctx, k.joint, MAIN_PX_PER_MM, 1);
    const gradient = ctx.createLinearGradient(0, -10, 0, 10);
    gradient.addColorStop(0, "rgba(255,146,195,.98)");
    gradient.addColorStop(0.48, "rgba(235,63,139,.98)");
    gradient.addColorStop(1, "rgba(145,24,84,.98)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.lineWidth = 1.05 * constantLine;
    ctx.strokeStyle = "rgba(255,191,220,.92)";
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.42;
    ctx.beginPath();
    ctx.moveTo(-k.joint.discLengthMm * MAIN_PX_PER_MM * 0.38, -1.5);
    ctx.quadraticCurveTo(0, -4.2, k.joint.discLengthMm * MAIN_PX_PER_MM * 0.38, -1.5);
    ctx.strokeStyle = "rgba(255,255,255,.72)";
    ctx.lineWidth = 0.7 * constantLine;
    ctx.stroke();
    ctx.restore();
  }

  function drawTemporalPatchMain(ctx, k, constantLine) {
    const joint = k.joint;
    const alpha = getLayerAlpha("temporal") * (state.display.xrayMode ? 0.54 : 0.92);
    const origin = k.baseCenter;
    const xStart = -24;
    const xEnd = Math.max(30, joint.eminenceLengthMm + 18);
    const p = MAIN_PX_PER_MM;

    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let x = xStart; x <= xEnd; x += 0.75) {
      const y = roofY(joint, x) * p;
      if (x === xStart) ctx.moveTo(x * p, y);
      else ctx.lineTo(x * p, y);
    }
    for (let x = xEnd; x >= xStart; x -= 1.2) {
      const undulation = Math.sin((x + 20) * 0.16) * 1.2;
      ctx.lineTo(x * p, roofY(joint, x) * p - (12 + undulation) * p);
    }
    ctx.closePath();
    const boneGradient = ctx.createLinearGradient(0, -55, 0, 30);
    boneGradient.addColorStop(0, "rgba(255,253,245,.98)");
    boneGradient.addColorStop(0.5, "rgba(224,214,193,.97)");
    boneGradient.addColorStop(1, "rgba(157,140,111,.97)");
    ctx.fillStyle = boneGradient;
    ctx.shadowColor = "rgba(0,0,0,.26)";
    ctx.shadowBlur = 5 * constantLine;
    ctx.shadowOffsetY = 2 * constantLine;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(96,78,52,.72)";
    ctx.lineWidth = 1.15 * constantLine;
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.46;
    ctx.setLineDash([3.5 * constantLine, 4.5 * constantLine]);
    ctx.beginPath();
    for (let x = xStart + 2; x <= xEnd - 2; x += 1) {
      const y = roofY(joint, x) * p - 5.7 * p;
      if (x === xStart + 2) ctx.moveTo(x * p, y); else ctx.lineTo(x * p, y);
    }
    ctx.strokeStyle = "rgba(255,255,255,.72)";
    ctx.lineWidth = 0.75 * constantLine;
    ctx.stroke();
    ctx.setLineDash([]);

    // Cortical contour of the functional articular surface.
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let x = xStart; x <= xEnd; x += 0.45) {
      const y = roofY(joint, x) * p;
      if (x === xStart) ctx.moveTo(x * p, y); else ctx.lineTo(x * p, y);
    }
    ctx.strokeStyle = "rgba(255,220,155,.95)";
    ctx.lineWidth = 1.4 * constantLine;
    ctx.stroke();
    ctx.restore();
  }

  function drawSoftTissuesMain(ctx, k, constantLine) {
    const alpha = getLayerAlpha("softTissue");
    const joint = k.joint;
    const c = k.condyleCenter;
    const d = k.discCenter;
    const p = MAIN_PX_PER_MM;
    ctx.save();
    ctx.globalAlpha = alpha;

    // Retrodiscal tissue fan.
    const posteriorX = d.x - joint.discLengthMm * p * 0.54;
    const elasticity = joint.retrodiscalElasticityPct / 100;
    const anchor = { x: k.baseCenter.x - 18 * p, y: k.baseCenter.y - 7 * p };
    const retroGradient = ctx.createLinearGradient(anchor.x, anchor.y, posteriorX, d.y);
    retroGradient.addColorStop(0, "rgba(92,184,134,.22)");
    retroGradient.addColorStop(1, "rgba(94,224,155,.68)");
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y - 6 * p);
    ctx.bezierCurveTo(anchor.x + 7 * p, anchor.y - 3 * p, posteriorX - 4 * p, d.y - 4 * p, posteriorX, d.y - 1.5 * p);
    ctx.bezierCurveTo(posteriorX - 4 * p, d.y + 4 * p, anchor.x + 5 * p * elasticity, anchor.y + 7 * p, anchor.x, anchor.y + 5 * p);
    ctx.closePath();
    ctx.fillStyle = retroGradient;
    ctx.fill();

    // Capsule.
    const lax = joint.capsuleLaxityPct / 100;
    ctx.beginPath();
    ctx.moveTo(k.baseCenter.x - 17 * p, k.baseCenter.y - 14 * p);
    ctx.bezierCurveTo(c.x - 20 * p, c.y - (16 + 6 * lax) * p, c.x + 17 * p, c.y - (13 + 5 * lax) * p, k.baseCenter.x + (joint.eminenceLengthMm + 13) * p, k.baseCenter.y - 5 * p);
    ctx.bezierCurveTo(c.x + 19 * p, c.y + (12 + 5 * lax) * p, c.x - 17 * p, c.y + (15 + 5 * lax) * p, k.baseCenter.x - 17 * p, k.baseCenter.y - 14 * p);
    ctx.strokeStyle = "rgba(116,223,168,.82)";
    ctx.lineWidth = 1.15 * constantLine;
    ctx.stroke();

    // Lateral ligament.
    ctx.beginPath();
    ctx.moveTo(k.baseCenter.x + 7 * p, k.baseCenter.y - 17 * p);
    ctx.lineTo(c.x + 4 * p, c.y + 15 * p);
    ctx.strokeStyle = "rgba(139,215,185,.62)";
    ctx.lineWidth = 2.1 * constantLine;
    ctx.stroke();
    ctx.restore();
  }

  function drawBaselineJointMain(ctx, k, constantLine) {
    const base = { ...DEFAULT_JOINT };
    const p = MAIN_PX_PER_MM;
    ctx.save();
    ctx.translate(k.baseCenter.x, k.baseCenter.y);
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([5 * constantLine, 5 * constantLine]);
    ctx.strokeStyle = "rgba(132,194,235,.8)";
    ctx.lineWidth = 1.05 * constantLine;
    ctx.beginPath();
    for (let x = -20; x <= 32; x += 0.6) {
      const y = roofY(base, x, true) * p;
      if (x === -20) ctx.moveTo(x * p, y); else ctx.lineTo(x * p, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawMotionPathsMain(ctx, k, constantLine) {
    const alpha = getLayerAlpha("paths");
    const p = MAIN_PX_PER_MM;
    const joint = k.joint;
    ctx.save();
    ctx.translate(k.baseCenter.x, k.baseCenter.y);
    ctx.globalAlpha = alpha;

    // Condylar path.
    ctx.beginPath();
    for (let x = 0; x <= 14; x += 0.2) {
      const y = condylarPathDrop(joint, x);
      if (x === 0) ctx.moveTo(0, 0); else ctx.lineTo(x * p, y * p);
    }
    ctx.strokeStyle = "rgba(67,181,255,.95)";
    ctx.lineWidth = 1.35 * constantLine;
    ctx.stroke();

    // Morphologic surface path for comparison.
    ctx.beginPath();
    for (let x = 0; x <= Math.max(14, joint.eminenceLengthMm); x += 0.2) {
      const y = roofY(joint, x) - roofY(joint, 0);
      if (x === 0) ctx.moveTo(0, 0); else ctx.lineTo(x * p, y * p);
    }
    ctx.setLineDash([3.5 * constantLine, 4.5 * constantLine]);
    ctx.strokeStyle = "rgba(255,211,122,.85)";
    ctx.lineWidth = 1.05 * constantLine;
    ctx.stroke();
    ctx.setLineDash([]);

    for (let x = 0; x <= 14; x += 2) {
      const y = condylarPathDrop(joint, x);
      ctx.beginPath();
      ctx.arc(x * p, y * p, 1.5 * constantLine, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(126,214,255,.95)";
      ctx.fill();
    }
    ctx.restore();

    // Current incisal trajectory segment.
    ctx.save();
    ctx.globalAlpha = alpha * 0.88;
    const baseIncisor = transformJawPoint(BASE_INCISOR, k.baseCenter, k.baseCenter, 0, state.patient.mandibleLengthPct / 100, state.patient.ramusHeightPct / 100);
    ctx.beginPath();
    ctx.moveTo(baseIncisor.x, baseIncisor.y);
    ctx.lineTo(k.incisorPoint.x, k.incisorPoint.y);
    ctx.strokeStyle = "rgba(255,104,174,.9)";
    ctx.lineWidth = 1.1 * constantLine;
    ctx.setLineDash([4 * constantLine, 4 * constantLine]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawPlanesMain(ctx, k, constantLine) {
    const opacity = state.display.xrayMode ? 0.75 : 0.62;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 1 * constantLine;
    ctx.setLineDash([6 * constantLine, 5 * constantLine]);

    ctx.beginPath();
    ctx.moveTo(390, 470);
    ctx.lineTo(840, 500);
    ctx.strokeStyle = "rgba(75,174,255,.9)";
    ctx.stroke();

    const angle = state.patient.occlusalPitchDeg * DEG;
    const start = { x: 575, y: 654 };
    const length = 290;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(start.x + Math.cos(angle) * length, start.y + Math.sin(angle) * length);
    ctx.strokeStyle = "rgba(255,91,168,.9)";
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawCurrentMarkersMain(ctx, k, constantLine) {
    const alpha = getLayerAlpha("paths");
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const [point, color] of [
      [k.condyleCenter, "#6dd9ff"],
      [k.discCenter, "#ff70b3"],
      [k.incisorPoint, "#ffd37a"],
    ]) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.2 * constantLine, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.4 * constantLine;
      ctx.strokeStyle = "rgba(255,255,255,.92)";
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSkullLabels(ctx, tr, k, width, height) {
    const leftView = state.selectedSide === "left";
    const sideSign = leftView ? -1 : 1;
    const joint = k.joint;
    const eminencePoint = {
      x: k.baseCenter.x + joint.eminenceLengthMm * MAIN_PX_PER_MM * 0.58,
      y: k.baseCenter.y + roofY(joint, joint.eminenceLengthMm * 0.58) * MAIN_PX_PER_MM,
    };
    const labels = [
      { text: "側頭骨", point: { x: 445, y: 460 }, dx: -86 * sideSign, dy: -48, color: "#dfeaf2" },
      { text: "関節窩", point: { x: k.baseCenter.x - 5 * MAIN_PX_PER_MM, y: k.baseCenter.y + roofY(joint, -5) * MAIN_PX_PER_MM }, dx: -102 * sideSign, dy: -4, color: "#ffd37a" },
      { text: "関節結節", point: eminencePoint, dx: 64 * sideSign, dy: -36, color: "#ffd37a" },
      { text: "関節円板", point: k.discCenter, dx: 70 * sideSign, dy: -8, color: "#ff79b8" },
      { text: "下顎頭", point: k.condyleCenter, dx: -95 * sideSign, dy: 38, color: "#d8c39d" },
      { text: "下顎骨", point: { x: 620, y: 725 }, dx: 76 * sideSign, dy: 42, color: "#cfdee8" },
    ];

    ctx.save();
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const item of labels) {
      const anchor = sourceToSkullScreen(item.point, tr);
      drawCallout(ctx, anchor, item.text, item.dx, item.dy, item.color, width, height);
    }

    if (state.display.showPlanes) {
      drawTag(ctx, sourceToSkullScreen({ x: 790, y: 496 }, tr), "Frankfort平面", "#6dd9ff", leftView ? -104 : 8, -18);
      drawTag(ctx, sourceToSkullScreen({ x: 775, y: 681 }, tr), "咬合平面", "#ff72b5", leftView ? -90 : 8, 14);
    }
    ctx.restore();
  }

  function drawCallout(ctx, anchor, text, dx, dy, color, width, height) {
    const padX = 7;
    const boxH = 22;
    const textW = ctx.measureText(text).width;
    let boxX = anchor.x + dx;
    let boxY = anchor.y + dy;
    if (dx < 0) boxX -= textW + padX * 2;
    boxX = clamp(boxX, 5, width - textW - padX * 2 - 5);
    boxY = clamp(boxY, 5, height - boxH - 5);
    const edgeX = dx < 0 ? boxX + textW + padX * 2 : boxX;
    const edgeY = boxY + boxH / 2;
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo((anchor.x + edgeX) / 2, edgeY);
    ctx.lineTo(edgeX, edgeY);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 2.3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    roundRect(ctx, boxX, boxY, textW + padX * 2, boxH, 6);
    ctx.fillStyle = "rgba(8,20,30,.84)";
    ctx.fill();
    ctx.strokeStyle = "rgba(146,182,207,.25)";
    ctx.stroke();
    ctx.fillStyle = "#edf6fb";
    ctx.fillText(text, boxX + padX, boxY + boxH / 2 + 0.5);
  }

  function drawTag(ctx, anchor, text, color, dx, dy) {
    const w = ctx.measureText(text).width + 14;
    const x = anchor.x + dx;
    const y = anchor.y + dy;
    roundRect(ctx, x, y, w, 20, 6);
    ctx.fillStyle = "rgba(8,20,30,.8)";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(text, x + 7, y + 10.5);
  }

  function drawSkullHud(ctx, tr, k, width, height) {
    const angle = k.joint.sagittalInclinationDeg;
    const morph = k.morphAngle;
    const boxW = 168;
    const boxH = 72;
    const x = width - boxW - 12;
    const y = 12;
    roundRect(ctx, x, y, boxW, boxH, 10);
    ctx.fillStyle = "rgba(5,15,24,.72)";
    ctx.fill();
    ctx.strokeStyle = "rgba(112,178,220,.2)";
    ctx.stroke();
    ctx.font = "600 9px system-ui, sans-serif";
    ctx.fillStyle = "#8fa9ba";
    ctx.fillText("顆路角 / 結節形態角", x + 10, y + 16);
    ctx.font = "700 18px system-ui, sans-serif";
    ctx.fillStyle = "#6dd9ff";
    ctx.fillText(`${angle.toFixed(1)}°`, x + 10, y + 40);
    ctx.fillStyle = "#ffd37a";
    ctx.fillText(`${morph.toFixed(1)}°`, x + 88, y + 40);
    ctx.font = "500 8px system-ui, sans-serif";
    ctx.fillStyle = "#7890a2";
    ctx.fillText(`差 ${Math.abs(angle - morph).toFixed(1)}°`, x + 10, y + 59);
    ctx.fillText(`隆起 ${effectiveEminenceHeight(k.joint).toFixed(1)} mm`, x + 75, y + 59);
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function detailTransform(width, height) {
    const scale = Math.min(width / 68, height / 50) * 0.9 * view.joint.zoom;
    return {
      scale,
      originX: width * 0.42 + view.joint.panX,
      originY: height * 0.58 + view.joint.panY,
      width,
      height,
    };
  }

  function detailToScreen(point, tr) {
    return { x: tr.originX + point.x * tr.scale, y: tr.originY + point.y * tr.scale };
  }

  function drawJoint() {
    const { ctx, width, height } = prepareCanvas(dom.jointCanvas);
    drawCanvasBackground(ctx, width, height, "joint");
    const k = computeKinematics();
    const joint = k.joint;
    const tr = detailTransform(width, height);

    if (state.display.showGrid) drawDetailGrid(ctx, tr);

    ctx.save();
    ctx.translate(tr.originX, tr.originY);
    ctx.scale(tr.scale, tr.scale);

    if (state.display.showBaseline) drawBaselineDetail(ctx, tr, k);
    if (state.display.showPaths && getLayerAlpha("paths") > 0) drawPathsDetail(ctx, tr, k);
    if (getLayerAlpha("softTissue") > 0) drawSoftTissueDetail(ctx, tr, k);
    if (getLayerAlpha("temporal") > 0) drawTemporalBoneDetail(ctx, tr, k);
    if (getLayerAlpha("mandible") > 0) drawMandibleNeckDetail(ctx, tr, k);
    if (getLayerAlpha("condyle") > 0) drawCondyleDetail(ctx, tr, k);
    if (getLayerAlpha("disc") > 0) drawDiscDetail(ctx, tr, k);
    drawJointSpaceDetail(ctx, tr, k);
    drawMeasurementsDetail(ctx, tr, k);
    ctx.restore();

    if (state.display.showLabels) drawDetailLabels(ctx, tr, k);
    drawDetailStatus(ctx, width, height, k);
  }

  function drawDetailGrid(ctx, tr) {
    ctx.save();
    ctx.strokeStyle = "rgba(126,178,211,.11)";
    ctx.lineWidth = 1;
    for (let x = tr.originX % (tr.scale * 5); x < tr.width; x += tr.scale * 5) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, tr.height); ctx.stroke();
    }
    for (let y = tr.originY % (tr.scale * 5); y < tr.height; y += tr.scale * 5) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(tr.width, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawTemporalBoneDetail(ctx, tr, k) {
    const joint = k.joint;
    const alpha = getLayerAlpha("temporal") * (state.display.xrayMode ? 0.55 : 0.94);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    const start = -28;
    const end = Math.max(34, joint.eminenceLengthMm + 18);
    for (let x = start; x <= end; x += 0.25) {
      const y = roofY(joint, x);
      if (x === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (let x = end; x >= start; x -= 0.4) {
      const y = roofY(joint, x) - 11 - Math.sin((x + 8) * 0.15) * 0.8;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, -28, 0, 8);
    gradient.addColorStop(0, "rgba(255,253,241,.98)");
    gradient.addColorStop(0.48, "rgba(226,213,187,.98)");
    gradient.addColorStop(1, "rgba(145,126,96,.98)");
    ctx.fillStyle = gradient;
    ctx.shadowColor = "rgba(0,0,0,.38)";
    ctx.shadowBlur = 0.7;
    ctx.shadowOffsetY = 0.35;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(91,73,48,.9)";
    ctx.lineWidth = 0.24;
    ctx.stroke();

    // Cancellous texture, deterministic.
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = alpha * 0.24;
    ctx.strokeStyle = "rgba(117,96,65,.55)";
    ctx.lineWidth = 0.12;
    for (let i = 0; i < 65; i += 1) {
      const x = start + ((i * 17.37) % (end - start));
      const roof = roofY(joint, x);
      const y = roof - 2.2 - ((i * 7.91) % 6.5);
      ctx.beginPath();
      ctx.moveTo(x - 0.8, y - 0.35);
      ctx.lineTo(x + 0.7, y + 0.42);
      ctx.moveTo(x + 0.1, y - 0.8);
      ctx.lineTo(x - 0.3, y + 0.8);
      ctx.stroke();
    }
    ctx.restore();

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let x = start; x <= end; x += 0.2) {
      const y = roofY(joint, x);
      if (x === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(255,218,146,.98)";
    ctx.lineWidth = 0.34;
    ctx.stroke();
    ctx.restore();
  }

  function drawMandibleNeckDetail(ctx, tr, k) {
    const joint = k.joint;
    const alpha = getLayerAlpha("mandible") * (state.display.xrayMode ? 0.58 : 0.9);
    ctx.save();
    ctx.translate(k.anteriorMm, k.dropMm);
    ctx.rotate(k.totalRotationRad * 0.34);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    const half = joint.condyleAPMm * 0.29;
    ctx.moveTo(-half, joint.condyleHeightMm * 0.28);
    ctx.bezierCurveTo(-half * 0.9, 9, -half * 0.62, 20, -half * 0.85, 31);
    ctx.lineTo(half * 0.98, 31);
    ctx.bezierCurveTo(half * 0.62, 20, half * 0.9, 9, half, joint.condyleHeightMm * 0.3);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(-7, 4, 8, 28);
    gradient.addColorStop(0, "rgba(238,230,211,.95)");
    gradient.addColorStop(0.62, "rgba(188,174,147,.94)");
    gradient.addColorStop(1, "rgba(118,104,82,.94)");
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = "rgba(79,66,50,.88)";
    ctx.lineWidth = 0.25;
    ctx.stroke();
    ctx.restore();
  }

  function drawCondyleDetail(ctx, tr, k) {
    const joint = k.joint;
    const alpha = getLayerAlpha("condyle");
    ctx.save();
    ctx.translate(k.anteriorMm, k.dropMm);
    ctx.rotate(k.totalRotationRad * 0.28 + k.tangentRad * 0.12);
    makeCondylePath(ctx, joint, 1);
    const gradient = ctx.createLinearGradient(-8, -6, 8, 7);
    gradient.addColorStop(0, "rgba(255,250,236,.99)");
    gradient.addColorStop(0.5, "rgba(221,207,178,.99)");
    gradient.addColorStop(1, "rgba(142,124,95,.99)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = "rgba(83,68,49,.95)";
    ctx.lineWidth = 0.28;
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.48;
    ctx.beginPath();
    ctx.ellipse(-joint.condyleAPMm * 0.1, -joint.condyleHeightMm * 0.15, joint.condyleAPMm * 0.29, joint.condyleHeightMm * 0.2, -0.14, Math.PI, Math.PI * 1.9);
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.lineWidth = 0.14;
    ctx.stroke();
    ctx.restore();
  }

  function drawDiscDetail(ctx, tr, k) {
    const joint = k.joint;
    const alpha = getLayerAlpha("disc");
    const condyleTop = k.dropMm - joint.condyleHeightMm / 2;
    const centerY = condyleTop - joint.discIntermediateMm * 0.48 - 0.25
      + (condylarPathDrop(joint, Math.max(0, k.discForwardMm)) - k.dropMm) * 0.22;
    ctx.save();
    ctx.translate(k.discForwardMm, centerY);
    ctx.rotate(k.discAngleRad);
    drawDiscPath(ctx, joint, 1, 1);
    const gradient = ctx.createLinearGradient(0, -3, 0, 3);
    gradient.addColorStop(0, "rgba(255,157,203,.99)");
    gradient.addColorStop(0.48, "rgba(234,57,137,.99)");
    gradient.addColorStop(1, "rgba(133,19,74,.99)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,194,222,.96)";
    ctx.lineWidth = 0.22;
    ctx.stroke();
    ctx.restore();
  }

  function drawSoftTissueDetail(ctx, tr, k) {
    const joint = k.joint;
    const alpha = getLayerAlpha("softTissue");
    const discY = k.dropMm - joint.condyleHeightMm / 2 - joint.discIntermediateMm * 0.5;
    const posteriorDiscX = k.discForwardMm - joint.discLengthMm / 2;
    ctx.save();
    ctx.globalAlpha = alpha;

    // Retrodiscal bilaminar zone.
    ctx.beginPath();
    ctx.moveTo(-22, roofY(joint, -18) - 1.6);
    ctx.bezierCurveTo(-15, -8.5, posteriorDiscX - 3, discY - 2.2, posteriorDiscX, discY - 0.5);
    ctx.bezierCurveTo(posteriorDiscX - 2, discY + 3.4, -14, 5.5, -21, 7.5);
    ctx.closePath();
    const retro = ctx.createLinearGradient(-22, 0, posteriorDiscX, 0);
    retro.addColorStop(0, "rgba(72,155,111,.22)");
    retro.addColorStop(1, "rgba(102,224,160,.72)");
    ctx.fillStyle = retro;
    ctx.fill();

    // Capsule.
    const lax = joint.capsuleLaxityPct / 100;
    ctx.beginPath();
    ctx.moveTo(-20, roofY(joint, -18) - 1);
    ctx.bezierCurveTo(-18, -18 - lax * 4, k.anteriorMm + 15, -16 - lax * 4, joint.eminenceLengthMm + 16, roofY(joint, joint.eminenceLengthMm + 12) + 1);
    ctx.bezierCurveTo(k.anteriorMm + 17, k.dropMm + 14 + lax * 4, k.anteriorMm - 17, k.dropMm + 15 + lax * 4, -20, roofY(joint, -18) - 1);
    ctx.strokeStyle = "rgba(117,227,170,.86)";
    ctx.lineWidth = 0.28;
    ctx.stroke();

    // Lateral ligament and stylomandibular guide.
    ctx.beginPath();
    ctx.moveTo(7, roofY(joint, 7) - 7);
    ctx.lineTo(k.anteriorMm + 3, k.dropMm + 13);
    ctx.strokeStyle = "rgba(151,228,195,.66)";
    ctx.lineWidth = 0.52;
    ctx.stroke();
    ctx.restore();
  }

  function drawJointSpaceDetail(ctx, tr, k) {
    if (!state.display.cutaway) return;
    const joint = k.joint;
    const condyleTop = k.dropMm - joint.condyleHeightMm / 2;
    const discY = condyleTop - joint.discIntermediateMm * 0.5;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#5ebeff";
    ctx.beginPath();
    ctx.ellipse(k.anteriorMm, condyleTop - joint.discIntermediateMm * 0.75, joint.condyleAPMm * 0.48, joint.superiorJointSpaceMm + joint.discIntermediateMm * 0.5, k.tangentRad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#8ed7ff";
    ctx.beginPath();
    ctx.ellipse(k.anteriorMm, discY + joint.discIntermediateMm * 0.9, joint.condyleAPMm * 0.44, joint.discIntermediateMm * 0.8, k.tangentRad, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPathsDetail(ctx, tr, k) {
    const joint = k.joint;
    const alpha = getLayerAlpha("paths");
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let x = 0; x <= 15; x += 0.15) {
      const y = condylarPathDrop(joint, x);
      if (x === 0) ctx.moveTo(0, 0); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(84,196,255,.98)";
    ctx.lineWidth = 0.27;
    ctx.stroke();
    ctx.beginPath();
    for (let x = 0; x <= Math.max(15, joint.eminenceLengthMm); x += 0.15) {
      const y = roofY(joint, x) - roofY(joint, 0);
      if (x === 0) ctx.moveTo(0, 0); else ctx.lineTo(x, y);
    }
    ctx.setLineDash([0.7, 0.7]);
    ctx.strokeStyle = "rgba(255,212,123,.9)";
    ctx.lineWidth = 0.2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(k.anteriorMm, k.dropMm, 0.52, 0, Math.PI * 2);
    ctx.fillStyle = "#71dcff";
    ctx.fill();
    ctx.restore();
  }

  function drawBaselineDetail(ctx, tr, k) {
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.setLineDash([0.8, 0.7]);
    ctx.beginPath();
    for (let x = -24; x <= 34; x += 0.2) {
      const y = roofY(DEFAULT_JOINT, x, true);
      if (x === -24) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(132,194,235,.86)";
    ctx.lineWidth = 0.2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawMeasurementsDetail(ctx, tr, k) {
    const joint = k.joint;
    const morph = k.morphAngle * DEG;
    const h = effectiveEminenceHeight(joint);
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = "rgba(255,211,122,.82)";
    ctx.fillStyle = "rgba(255,211,122,.9)";
    ctx.lineWidth = 0.16;
    ctx.setLineDash([0.55, 0.45]);
    ctx.beginPath();
    ctx.moveTo(0, roofY(joint, 0));
    ctx.lineTo(joint.eminenceLengthMm, roofY(joint, 0));
    ctx.lineTo(joint.eminenceLengthMm, roofY(joint, joint.eminenceLengthMm));
    ctx.stroke();
    ctx.setLineDash([]);

    // Angle arc at the start of the eminence.
    ctx.beginPath();
    ctx.arc(0, roofY(joint, 0), 5, 0, morph, false);
    ctx.strokeStyle = "rgba(255,211,122,.95)";
    ctx.lineWidth = 0.25;
    ctx.stroke();

    // Condyle dimensions.
    const x = k.anteriorMm;
    const y = k.dropMm;
    ctx.strokeStyle = "rgba(217,238,250,.52)";
    ctx.lineWidth = 0.14;
    ctx.beginPath();
    ctx.moveTo(x - joint.condyleAPMm / 2, y + joint.condyleHeightMm / 2 + 2.4);
    ctx.lineTo(x + joint.condyleAPMm / 2, y + joint.condyleHeightMm / 2 + 2.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + joint.condyleAPMm / 2 + 2.4, y - joint.condyleHeightMm / 2);
    ctx.lineTo(x + joint.condyleAPMm / 2 + 2.4, y + joint.condyleHeightMm / 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawDetailLabels(ctx, tr, k) {
    const joint = k.joint;
    ctx.save();
    ctx.font = "600 9px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const points = [
      { t: "関節窩", p: { x: -8, y: roofY(joint, -8) }, dx: -70, dy: -35, c: "#f2dfb8" },
      { t: "関節結節", p: { x: joint.eminenceLengthMm * 0.65, y: roofY(joint, joint.eminenceLengthMm * 0.65) }, dx: 35, dy: -34, c: "#ffd37a" },
      { t: "関節円板", p: { x: k.discForwardMm, y: k.dropMm - joint.condyleHeightMm / 2 - joint.discIntermediateMm * 0.6 }, dx: 48, dy: -2, c: "#ff77b7" },
      { t: "下顎頭", p: { x: k.anteriorMm, y: k.dropMm }, dx: 47, dy: 35, c: "#dcc9a4" },
      { t: "後部結合組織", p: { x: k.discForwardMm - joint.discLengthMm / 2 - 5, y: -1 }, dx: -104, dy: 34, c: "#80ddad" },
    ];
    for (const item of points) drawCallout(ctx, detailToScreen(item.p, tr), item.t, item.dx, item.dy, item.c, tr.width, tr.height);

    const morphPos = detailToScreen({ x: joint.eminenceLengthMm * 0.43, y: roofY(joint, 0) + effectiveEminenceHeight(joint) * 0.25 }, tr);
    ctx.fillStyle = "#ffd37a";
    ctx.font = "700 10px system-ui, sans-serif";
    ctx.fillText(`${k.morphAngle.toFixed(1)}°`, morphPos.x + 5, morphPos.y - 5);
    ctx.restore();
  }

  function drawDetailStatus(ctx, width, height, k) {
    const w = 166;
    const h = 59;
    const x = width - w - 10;
    const y = 10;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fillStyle = "rgba(5,15,24,.76)";
    ctx.fill();
    ctx.strokeStyle = "rgba(113,180,223,.2)";
    ctx.stroke();
    ctx.font = "600 8px system-ui, sans-serif";
    ctx.fillStyle = "#8fa7b8";
    ctx.fillText("円板―下顎頭関係", x + 9, y + 14);
    ctx.font = "700 10px system-ui, sans-serif";
    ctx.fillStyle = "#ff82bd";
    const text = discRelationText(k);
    ctx.fillText(text.length > 17 ? `${text.slice(0, 17)}…` : text, x + 9, y + 31);
    ctx.font = "500 8px system-ui, sans-serif";
    ctx.fillStyle = "#8fa7b8";
    ctx.fillText(`相対位 ${k.effectiveDiscOffsetMm.toFixed(1)} mm / 復位率 ${(k.reductionProgress * 100).toFixed(0)}%`, x + 9, y + 47);

    ctx.save();
    ctx.font = "600 8px system-ui, sans-serif";
    ctx.fillStyle = "rgba(207,229,241,.62)";
    ctx.fillText("後方", 9, height - 13);
    ctx.fillText("前方 →", width - 47, height - 13);
    ctx.restore();
  }

  function drawTopView() {
    const { ctx, width, height } = prepareCanvas(dom.topCanvas);
    const padding = 18;
    const maxWidthMm = Math.max(160, state.patient.intercondylarMm + 42);
    const scale = Math.min((width - padding * 2) / maxWidthMm, (height - padding * 2) / 48);
    const origin = { x: width / 2, y: height - 24 };
    const left = state.joints.left;
    const right = state.joints.right;
    const half = state.patient.intercondylarMm / 2;

    const toScreen = (xMm, yMm) => ({ x: origin.x + xMm * scale, y: origin.y - yMm * scale });
    ctx.fillStyle = "rgba(5,15,24,.45)";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(126,177,210,.14)";
    ctx.lineWidth = 1;
    for (let y = 0; y <= 40; y += 10) {
      const p = toScreen(0, y);
      ctx.beginPath(); ctx.moveTo(padding, p.y); ctx.lineTo(width - padding, p.y); ctx.stroke();
    }

    const leftCenter = toScreen(-half, 0);
    const rightCenter = toScreen(half, 0);
    ctx.beginPath(); ctx.moveTo(leftCenter.x, leftCenter.y); ctx.lineTo(rightCenter.x, rightCenter.y);
    ctx.strokeStyle = "rgba(212,229,240,.4)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    drawTopCondyle(ctx, leftCenter, left, scale, state.selectedSide === "left", "L");
    drawTopCondyle(ctx, rightCenter, right, scale, state.selectedSide === "right", "R");

    drawBennettPath(ctx, leftCenter, left, scale, 1, "rgba(98,193,255,.88)");
    drawBennettPath(ctx, rightCenter, right, scale, -1, "rgba(255,116,181,.88)");

    const lateral = state.motion.lateralMm;
    if (Math.abs(lateral) > 0.02) {
      const excursionLeft = lateral > 0;
      const nonworkingJoint = excursionLeft ? right : left;
      const start = excursionLeft ? rightCenter : leftCenter;
      const dir = excursionLeft ? -1 : 1;
      const forward = Math.abs(lateral) * 0.64;
      const shift = nonworkingJoint.immediateSideShiftMm + forward * Math.tan(nonworkingJoint.bennettDeg * DEG);
      const end = toScreen((excursionLeft ? half : -half) + dir * shift, forward);
      ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
      ctx.strokeStyle = "rgba(255,219,126,.95)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, Math.PI * 2); ctx.fillStyle = "#ffd37a"; ctx.fill();
    }

    ctx.font = "600 8px system-ui, sans-serif";
    ctx.fillStyle = "#7f99ac";
    ctx.fillText("前方", width / 2 + 6, 13);
    ctx.beginPath(); ctx.moveTo(width / 2, 20); ctx.lineTo(width / 2, 7); ctx.strokeStyle = "rgba(126,194,235,.48)"; ctx.stroke();
  }

  function drawTopCondyle(ctx, center, joint, scale, selected, label) {
    ctx.save();
    ctx.translate(center.x, center.y);
    const w = joint.condyleMLMm * scale;
    const h = joint.condyleAPMm * scale * 0.62;
    const gradient = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    gradient.addColorStop(0, selected ? "rgba(248,238,214,.98)" : "rgba(206,198,180,.75)");
    gradient.addColorStop(1, selected ? "rgba(147,130,100,.98)" : "rgba(116,108,94,.72)");
    ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = gradient; ctx.fill();
    ctx.strokeStyle = selected ? "rgba(104,196,255,.92)" : "rgba(215,229,238,.4)";
    ctx.lineWidth = selected ? 2 : 1; ctx.stroke();
    ctx.fillStyle = selected ? "#dff5ff" : "#9aafbd";
    ctx.font = "700 8px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, 0, 3);
    ctx.restore();
  }

  function drawBennettPath(ctx, center, joint, scale, medialDirection, color) {
    const distance = 28;
    const angle = joint.bennettDeg * DEG;
    const end = {
      x: center.x + medialDirection * Math.sin(angle) * distance * scale,
      y: center.y - Math.cos(angle) * distance * scale,
    };
    ctx.save();
    ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(end.x, end.y);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(end.x, end.y, 2.3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  function motionForProgress(kind, progress) {
    const p = clamp(progress, 0, 1);
    if (kind === "lateral") {
      return { openingMm: 0, protrusionMm: 0, lateralMm: Math.sin(p * Math.PI * 2) * 12 };
    }
    const cycle = p <= 0.5 ? easeInOut(p * 2) : easeInOut((1 - p) * 2);
    if (kind === "open") return { openingMm: 45 * cycle, protrusionMm: 0, lateralMm: 0 };
    return { openingMm: 0, protrusionMm: 12 * cycle, lateralMm: 0 };
  }

  function drawTimeline() {
    const { ctx, width, height } = prepareCanvas(dom.timelineCanvas);
    const left = 44;
    const right = 132;
    const top = 12;
    const bottom = 22;
    const plotW = Math.max(20, width - left - right);
    const plotH = Math.max(20, height - top - bottom);
    const yMin = -5;
    const yMax = 46;
    const xAt = (t) => left + t * plotW;
    const yAt = (v) => top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    ctx.fillStyle = "rgba(7,17,26,.38)";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "500 8px system-ui, sans-serif";
    ctx.fillStyle = "#718b9e";
    ctx.strokeStyle = "rgba(128,174,204,.12)";
    ctx.lineWidth = 1;
    for (let v = 0; v <= 40; v += 10) {
      const y = yAt(v);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
      ctx.fillText(String(v), 19, y + 3);
    }
    for (let t = 0; t <= 4; t += 1) {
      const x = left + (t / 4) * plotW;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
      ctx.fillText(`${t}s`, x - 4, height - 7);
    }

    const series = [
      { color: "#ffd37a", label: "切歯点開口", value: (m, k) => m.openingMm },
      { color: "#4ab5ff", label: "顆頭前方移動", value: (m, k) => k.anteriorMm },
      { color: "#77ddff", label: "顆頭下方移動", value: (m, k) => k.dropMm },
      { color: "#ff68ad", label: "円板相対位", value: (m, k) => k.effectiveDiscOffsetMm },
    ];

    for (const item of series) {
      ctx.beginPath();
      for (let i = 0; i <= 140; i += 1) {
        const p = i / 140;
        const m = motionForProgress(animation.kind, p);
        const k = computeKinematics(state.selectedSide, m);
        const x = xAt(p);
        const y = yAt(item.value(m, k));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    const currentX = xAt(animation.progress);
    ctx.beginPath(); ctx.moveTo(currentX, top); ctx.lineTo(currentX, top + plotH);
    ctx.strokeStyle = "rgba(255,255,255,.72)";
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(currentX, top + 3, 3, 0, Math.PI * 2); ctx.fillStyle = "white"; ctx.fill();

    let legendY = 17;
    ctx.font = "600 8px system-ui, sans-serif";
    for (const item of series) {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(width - right + 13, legendY); ctx.lineTo(width - right + 30, legendY); ctx.stroke();
      ctx.fillStyle = "#91a8b8";
      ctx.fillText(item.label, width - right + 36, legendY + 3);
      legendY += 17;
    }
    ctx.fillStyle = "#718b9e";
    ctx.fillText("縦軸：mm", width - right + 13, height - 10);
  }

  function updateReadouts() {
    const k = computeKinematics();
    const joint = k.joint;
    dom.metricCondyleForward.textContent = `${k.anteriorMm.toFixed(1)} mm`;
    dom.metricCondyleDrop.textContent = `${k.dropMm.toFixed(1)} mm`;
    dom.metricJawRotation.textContent = `${(k.totalRotationRad * RAD).toFixed(1)}°`;
    dom.metricMorphologyAngle.textContent = `${k.morphAngle.toFixed(1)}°`;
    dom.metricSagittalLateralAngle.textContent = `${sagittalLateralProjectionAngle(joint).toFixed(1)}°`;
    dom.metricDiscOffset.textContent = `${k.effectiveDiscOffsetMm.toFixed(1)} mm`;
    dom.metricClearance.textContent = k.clearanceMm > 0 ? `${k.clearanceMm.toFixed(1)} mm` : `接近 ${Math.abs(k.clearanceMm).toFixed(1)} mm`;
    dom.metricClearance.classList.toggle("warning", k.clearanceMm <= 0);
    dom.metricWorkingSide.textContent = k.relation === "working" ? "作業側" : k.relation === "nonworking" ? "非作業側" : "中心位";
    dom.discRelationStatus.textContent = discRelationText(k);
    dom.linkedHeightReadout.textContent = `${effectiveEminenceHeight(joint).toFixed(1)} mm`;
    dom.morphologyAngleBadge.textContent = `形態角 ${k.morphAngle.toFixed(1)}°`;
    dom.motionPhaseBadge.textContent = phaseText();
    dom.viewSideLabel.textContent = state.selectedSide === "right" ? "右側面" : "左側面";
    dom.selectedSideChip.textContent = state.selectedSide === "right" ? "右" : "左";
    dom.topLeftAngle.textContent = `${state.joints.left.bennettDeg.toFixed(1)}°`;
    dom.topRightAngle.textContent = `${state.joints.right.bennettDeg.toFixed(1)}°`;
    dom.topIntercondylar.textContent = `${state.patient.intercondylarMm.toFixed(0)} mm`;

    const compatibility = clamp(100 - (k.mismatchDeg / 22) * 100, 0, 100);
    dom.compatibilityBar.style.width = `${compatibility}%`;
    if (compatibility > 92) {
      dom.compatibilityLabel.textContent = "一致";
      dom.compatibilityLabel.style.color = "#7be0ae";
      dom.compatibilityBar.style.background = "linear-gradient(90deg,#5ad5a1,#7fe3bd)";
      dom.compatibilityNote.textContent = joint.linkEminenceToGuidance ? "形態連動が有効です。" : "設定角と形態角が近接しています。";
    } else if (compatibility > 62) {
      dom.compatibilityLabel.textContent = "軽度差";
      dom.compatibilityLabel.style.color = "#ffd37a";
      dom.compatibilityBar.style.background = "linear-gradient(90deg,#e7b957,#ffd37a)";
      dom.compatibilityNote.textContent = `顆路角と形態角に ${k.mismatchDeg.toFixed(1)}° の差があります。`;
    } else {
      dom.compatibilityLabel.textContent = "差が大きい";
      dom.compatibilityLabel.style.color = "#ff786f";
      dom.compatibilityBar.style.background = "linear-gradient(90deg,#e0615b,#ff847b)";
      dom.compatibilityNote.textContent = "運動経路が骨表面から離開・交差する教育的比較状態です。";
    }

    dom.skullZoomBadge.textContent = `${Math.round(view.skull.zoom * 100)}%`;
    dom.jointModeBadge.textContent = state.display.cutaway ? "断面表示" : "透過表示";
    dom.timelineTime.textContent = `${(animation.progress * animation.durationSeconds).toFixed(2)} / ${animation.durationSeconds.toFixed(2)} 秒`;
    dom.timelineScrubber.value = String(Math.round(animation.progress * 1000));
    dom.timelinePlayButton.textContent = animation.playing ? "❚❚" : "▶";
  }

  function syncControls() {
    document.querySelectorAll("[data-key]").forEach((element) => {
      const value = getPath(state, element.dataset.key);
      if (element.type === "checkbox") element.checked = Boolean(value);
      else element.value = String(value);
    });
    document.querySelectorAll("[data-number-for]").forEach((element) => {
      element.value = String(getPath(state, element.dataset.numberFor));
    });
    document.querySelectorAll("[data-output]").forEach((element) => {
      const value = Number(getPath(state, element.dataset.output));
      element.value = Number.isFinite(value) ? value.toFixed(1) : "—";
      element.textContent = element.value;
    });

    const joint = selectedJoint();
    document.querySelectorAll("[data-side-key]").forEach((element) => {
      const key = element.dataset.sideKey;
      const value = key === "eminenceHeightMm" && joint.linkEminenceToGuidance ? effectiveEminenceHeight(joint) : joint[key];
      if (element.type === "checkbox") element.checked = Boolean(value);
      else element.value = String(value);
      if (key === "eminenceHeightMm") element.disabled = joint.linkEminenceToGuidance;
    });
    document.querySelectorAll("[data-side-number-for]").forEach((element) => {
      const key = element.dataset.sideNumberFor;
      const value = key === "eminenceHeightMm" && joint.linkEminenceToGuidance ? effectiveEminenceHeight(joint) : joint[key];
      element.value = typeof value === "number" ? String(Number(value.toFixed(2))) : String(value);
      if (key === "eminenceHeightMm") element.disabled = joint.linkEminenceToGuidance;
    });

    document.querySelectorAll(".side-button").forEach((button) => button.classList.toggle("active", button.dataset.side === state.selectedSide));
    document.querySelectorAll(".view-mode").forEach((button) => button.classList.toggle("active", button.dataset.layout === state.display.layout));
    dom.viewportGrid.dataset.layout = state.display.layout;
    dom.toggleLabelsButton.classList.toggle("active", state.display.showLabels);

    for (const [name, layer] of Object.entries(state.display.layers)) {
      const visible = document.querySelector(`[data-layer-visible="${name}"]`);
      const opacity = document.querySelector(`[data-layer-opacity="${name}"]`);
      const output = document.querySelector(`[data-layer-output="${name}"]`);
      if (visible) visible.checked = layer.visible;
      if (opacity) opacity.value = String(Math.round(layer.opacity * 100));
      if (output) output.textContent = `${Math.round(layer.opacity * 100)}%`;
    }

    updateReadouts();
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      drawSkull();
      drawJoint();
      drawTopView();
      drawTimeline();
      updateReadouts();
    });
  }

  function bindDataControls() {
    document.querySelectorAll("[data-key]").forEach((element) => {
      const eventName = element.tagName === "SELECT" || element.type === "checkbox" ? "change" : "input";
      element.addEventListener(eventName, () => {
        const path = element.dataset.key;
        let value;
        if (element.type === "checkbox") value = element.checked;
        else if (element.tagName === "SELECT" && !Number.isFinite(Number(element.value))) value = element.value;
        else value = element.tagName === "SELECT" && path === "motion.animationSpeed" ? Number(element.value) : Number(element.value);
        setPath(state, path, value);
        if (path === "display.focusTarget") applyFocusPreset(value);
        if (path.startsWith("motion.")) stopAnimation(false);
        syncControls();
        scheduleRender();
      });
    });

    document.querySelectorAll("[data-number-for]").forEach((element) => {
      element.addEventListener("change", () => {
        const path = element.dataset.numberFor;
        const value = clamp(Number(element.value), Number(element.min), Number(element.max));
        setPath(state, path, value);
        stopAnimation(false);
        syncControls();
        scheduleRender();
      });
    });

    document.querySelectorAll("[data-side-key]").forEach((element) => {
      const eventName = element.tagName === "SELECT" || element.type === "checkbox" ? "change" : "input";
      element.addEventListener(eventName, () => {
        const joint = selectedJoint();
        const key = element.dataset.sideKey;
        let value;
        if (element.type === "checkbox") value = element.checked;
        else if (element.tagName === "SELECT") value = element.value;
        else value = Number(element.value);
        if (key === "linkEminenceToGuidance" && value === false) joint.eminenceHeightMm = effectiveEminenceHeight(joint);
        joint[key] = value;
        stopAnimation(false);
        syncControls();
        scheduleRender();
      });
    });

    document.querySelectorAll("[data-side-number-for]").forEach((element) => {
      element.addEventListener("change", () => {
        const joint = selectedJoint();
        const key = element.dataset.sideNumberFor;
        if (key === "eminenceHeightMm" && joint.linkEminenceToGuidance) return;
        joint[key] = clamp(Number(element.value), Number(element.min), Number(element.max));
        stopAnimation(false);
        syncControls();
        scheduleRender();
      });
    });

    document.querySelectorAll("[data-layer-visible]").forEach((element) => {
      element.addEventListener("change", () => {
        state.display.layers[element.dataset.layerVisible].visible = element.checked;
        syncControls();
        scheduleRender();
      });
    });
    document.querySelectorAll("[data-layer-opacity]").forEach((element) => {
      element.addEventListener("input", () => {
        state.display.layers[element.dataset.layerOpacity].opacity = Number(element.value) / 100;
        syncControls();
        scheduleRender();
      });
    });
  }

  function bindNavigation() {
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === button));
        document.querySelectorAll(".tab-page").forEach((page) => page.classList.toggle("active", page.dataset.page === button.dataset.tab));
      });
    });

    document.querySelectorAll(".side-button").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedSide = button.dataset.side;
        stopAnimation(false);
        syncControls();
        scheduleRender();
      });
    });

    document.querySelectorAll(".view-mode").forEach((button) => {
      button.addEventListener("click", () => {
        state.display.layout = button.dataset.layout;
        syncControls();
        requestAnimationFrame(scheduleRender);
      });
    });
  }

  function bindButtons() {
    dom.centricButton.addEventListener("click", () => {
      stopAnimation(false);
      state.motion.openingMm = 0;
      state.motion.protrusionMm = 0;
      state.motion.lateralMm = 0;
      animation.progress = 0;
      syncControls(); scheduleRender();
    });

    document.querySelectorAll("[data-animation]").forEach((button) => {
      button.addEventListener("click", () => startAnimation(button.dataset.animation));
    });
    dom.timelinePlayButton.addEventListener("click", () => {
      if (animation.playing) stopAnimation(true); else startAnimation(animation.kind, true);
    });
    dom.timelineScrubber.addEventListener("input", () => {
      stopAnimation(false);
      animation.progress = Number(dom.timelineScrubber.value) / 1000;
      applyAnimationProgress();
      syncControls(); scheduleRender();
    });

    dom.resetAllButton.addEventListener("click", () => {
      state = deepClone(DEFAULT_STATE);
      animation.progress = 0;
      stopAnimation(false);
      applyFocusPreset("all");
      safeReplaceState(location.pathname + location.search);
      syncControls(); scheduleRender();
      toast("全設定を初期化しました。", "ok");
    });
    dom.helpButton.addEventListener("click", () => dom.helpDialog.showModal());
    dom.fitViewButton.addEventListener("click", () => {
      applyFocusPreset(state.display.focusTarget);
      scheduleRender();
    });
    dom.focusJointButton.addEventListener("click", () => {
      state.display.focusTarget = state.display.focusTarget === "tmj" ? "all" : "tmj";
      applyFocusPreset(state.display.focusTarget);
      syncControls(); scheduleRender();
    });
    dom.toggleLabelsButton.addEventListener("click", () => {
      state.display.showLabels = !state.display.showLabels;
      syncControls(); scheduleRender();
    });
    dom.showAllLayersButton.addEventListener("click", () => {
      for (const layer of Object.values(state.display.layers)) {
        layer.visible = true;
        layer.opacity = layer === state.display.layers.softTissue ? 0.7 : 1;
      }
      syncControls(); scheduleRender();
    });

    document.querySelectorAll("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => applyPreset(button.dataset.preset));
    });

    dom.exportJsonButton.addEventListener("click", exportJson);
    dom.importJsonButton.addEventListener("click", () => dom.jsonFileInput.click());
    dom.jsonFileInput.addEventListener("change", importJson);
    dom.copyShareButton.addEventListener("click", copyShareUrl);
    dom.captureButton.addEventListener("click", capturePng);
  }

  function bindCanvasNavigation(canvas, target) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      target.panX += dx;
      target.panY += dy;
      scheduleRender();
    });
    const end = (event) => {
      dragging = false;
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0012);
      target.zoom = clamp(target.zoom * factor, target === view.skull ? 0.55 : 0.65, target === view.skull ? 4.8 : 4.2);
      scheduleRender();
    }, { passive: false });
    canvas.addEventListener("dblclick", () => {
      if (target === view.skull) applyFocusPreset(state.display.focusTarget);
      else { target.zoom = 1; target.panX = 0; target.panY = 0; }
      scheduleRender();
    });
  }

  function applyFocusPreset(target) {
    const settings = {
      all: { centerX: 450, centerY: 455, zoom: 1 },
      tmj: { centerX: 500, centerY: 548, zoom: 2.18 },
      eminence: { centerX: 520, centerY: 525, zoom: 3.05 },
      condyle: { centerX: 500, centerY: 553, zoom: 3.0 },
      disc: { centerX: 505, centerY: 532, zoom: 3.28 },
      mandible: { centerX: 620, centerY: 690, zoom: 1.42 },
    }[target] || { centerX: 450, centerY: 455, zoom: 1 };
    Object.assign(view.skull, settings, { panX: 0, panY: 0 });
    view.joint.zoom = target === "all" || target === "mandible" ? 1 : target === "tmj" ? 1.08 : 1.25;
    view.joint.panX = 0;
    view.joint.panY = 0;
  }

  function startAnimation(kind, resume = false) {
    if (animation.playing && animation.kind === kind) {
      stopAnimation(true);
      return;
    }
    stopAnimation(false);
    animation.kind = kind;
    if (!resume || animation.progress >= 0.999) animation.progress = 0;
    animation.playing = true;
    animation.startProgress = animation.progress;
    animation.startedAt = performance.now();
    document.querySelectorAll("[data-animation]").forEach((button) => button.classList.toggle("running", button.dataset.animation === kind));
    animation.raf = requestAnimationFrame(animationTick);
    syncControls();
  }

  function stopAnimation(preserveProgress = true) {
    if (animation.raf) cancelAnimationFrame(animation.raf);
    animation.raf = 0;
    animation.playing = false;
    if (!preserveProgress) animation.progress = clamp(animation.progress, 0, 1);
    document.querySelectorAll("[data-animation]").forEach((button) => button.classList.remove("running"));
  }

  function animationTick(now) {
    if (!animation.playing) return;
    const speed = Number(state.motion.animationSpeed) || 1;
    const elapsed = (now - animation.startedAt) / 1000;
    animation.progress = animation.startProgress + elapsed * speed / animation.durationSeconds;
    if (animation.progress >= 1) {
      animation.progress %= 1;
      animation.startedAt = now;
      animation.startProgress = 0;
    }
    applyAnimationProgress();
    syncControls();
    scheduleRender();
    animation.raf = requestAnimationFrame(animationTick);
  }

  function applyAnimationProgress() {
    const motion = motionForProgress(animation.kind, animation.progress);
    state.motion.openingMm = motion.openingMm;
    state.motion.protrusionMm = motion.protrusionMm;
    state.motion.lateralMm = motion.lateralMm;
  }

  function applyPreset(name) {
    stopAnimation(false);
    const side = state.selectedSide;
    const joint = state.joints[side];
    switch (name) {
      case "average":
        state.joints.right = deepClone(DEFAULT_JOINT);
        state.joints.left = deepClone(DEFAULT_JOINT);
        state.motion.openingMm = 0; state.motion.protrusionMm = 0; state.motion.lateralMm = 0;
        break;
      case "flat":
        for (const j of Object.values(state.joints)) {
          j.sagittalInclinationDeg = 20; j.eminenceLengthMm = 13; j.linkEminenceToGuidance = true; j.fossaDepthMm = 3;
        }
        break;
      case "steep":
        for (const j of Object.values(state.joints)) {
          j.sagittalInclinationDeg = 55; j.eminenceLengthMm = 10; j.linkEminenceToGuidance = true; j.fossaDepthMm = 5.8;
        }
        break;
      case "large-condyle":
        joint.condyleAPMm = 24; joint.condyleHeightMm = 13; joint.condyleMLMm = 28; joint.superiorJointSpaceMm = 1.5; joint.condyleShape = "oval";
        state.display.focusTarget = "condyle";
        break;
      case "disc-reduction":
        joint.discDisplacementMm = 5.2; joint.discReduction = true; joint.discReductionThresholdMm = 3; joint.discMobilityPct = 88;
        state.display.focusTarget = "disc";
        break;
      case "disc-nonreducing":
        joint.discDisplacementMm = 5.6; joint.discReduction = false; joint.discMobilityPct = 34; joint.discDeformationPct = 35;
        state.display.focusTarget = "disc";
        break;
      case "symmetric":
        state.joints[side === "right" ? "left" : "right"] = deepClone(joint);
        break;
      case "asymmetric":
        state.joints.right = { ...deepClone(DEFAULT_JOINT), sagittalInclinationDeg: 48, eminenceLengthMm: 11, condyleAPMm: 21, bennettDeg: 19 };
        state.joints.left = { ...deepClone(DEFAULT_JOINT), sagittalInclinationDeg: 25, eminenceLengthMm: 14, condyleAPMm: 15, condyleHeightMm: 7.5, bennettDeg: 10, discDisplacementMm: 2.4 };
        break;
      default:
        return;
    }
    applyFocusPreset(state.display.focusTarget);
    syncControls(); scheduleRender();
    toast("プリセットを適用しました。", "ok");
  }

  function exportJson() {
    const payload = { ...deepClone(state), exportedAt: new Date().toISOString(), app: "TMJ Atlas Lab" };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, `tmj-atlas-case-${dateStamp()}.json`);
    setSaveStatus("JSONを保存しました。", true);
  }

  async function importJson(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      state = mergeWithDefaults(DEFAULT_STATE, parsed);
      state.version = VERSION;
      stopAnimation(false);
      applyFocusPreset(state.display.focusTarget);
      syncControls(); scheduleRender();
      setSaveStatus("JSON症例を読み込みました。", true);
    } catch (error) {
      console.error(error);
      setSaveStatus("JSONを読み込めませんでした。形式を確認してください。", false);
    }
  }

  function encodeState(value) {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeState(encoded) {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((encoded.length + 3) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function copyShareUrl() {
    const url = new URL(location.href);
    url.hash = `case=${encodeState(state)}`;
    try {
      await navigator.clipboard.writeText(url.toString());
      safeReplaceState(url.toString());
      setSaveStatus("共有URLをクリップボードへコピーしました。", true);
    } catch {
      safeReplaceState(url.toString());
      const input = document.createElement("textarea");
      input.value = url.toString();
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      setSaveStatus("共有URLを作成しました。", true);
    }
  }

  function loadHashState() {
    const hash = location.hash.startsWith("#case=") ? location.hash.slice(6) : "";
    if (!hash) return;
    try {
      const parsed = decodeState(hash);
      state = mergeWithDefaults(DEFAULT_STATE, parsed);
      state.version = VERSION;
      applyFocusPreset(state.display.focusTarget);
      toast("共有URLの症例設定を読み込みました。", "ok");
    } catch (error) {
      console.warn("共有状態を読み込めませんでした", error);
    }
  }

  function capturePng() {
    scheduleRender();
    requestAnimationFrame(() => {
      const out = document.createElement("canvas");
      out.width = 1800;
      out.height = 1000;
      const ctx = out.getContext("2d");
      const bg = ctx.createLinearGradient(0, 0, 0, out.height);
      bg.addColorStop(0, "#102131"); bg.addColorStop(1, "#07121c");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height);
      ctx.fillStyle = "#eef7fc"; ctx.font = "700 30px system-ui, sans-serif"; ctx.fillText("TMJ Atlas Lab", 54, 60);
      ctx.fillStyle = "#8fa9bb"; ctx.font = "500 17px system-ui, sans-serif"; ctx.fillText("解剖学的顎関節・半調節性咬合器シミュレーター", 54, 88);

      ctx.fillStyle = "#0b1925"; roundRect(ctx, 42, 112, 1090, 770, 20); ctx.fill();
      ctx.strokeStyle = "rgba(137,181,211,.22)"; ctx.stroke();
      ctx.drawImage(dom.skullCanvas, 54, 124, 1066, 746);

      ctx.fillStyle = "#0b1925"; roundRect(ctx, 1148, 112, 610, 545, 20); ctx.fill(); ctx.stroke();
      ctx.drawImage(dom.jointCanvas, 1160, 124, 586, 521);

      const k = computeKinematics();
      ctx.fillStyle = "rgba(13,31,45,.95)"; roundRect(ctx, 1148, 674, 610, 208, 18); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#eaf5fb"; ctx.font = "700 20px system-ui, sans-serif"; ctx.fillText(`${state.selectedSide === "right" ? "右" : "左"}側顎関節 — 現在値`, 1172, 710);
      ctx.font = "500 15px system-ui, sans-serif";
      const lines = [
        `矢状前方顆路傾斜角: ${k.joint.sagittalInclinationDeg.toFixed(1)}°`,
        `関節結節形態角: ${k.morphAngle.toFixed(1)}° / 隆起: ${effectiveEminenceHeight(k.joint).toFixed(1)} mm`,
        `下顎頭: ${k.joint.condyleAPMm.toFixed(1)} × ${k.joint.condyleHeightMm.toFixed(1)} mm`,
        `円板相対位: ${k.effectiveDiscOffsetMm.toFixed(1)} mm — ${discRelationText(k)}`,
        `運動: 前方 ${k.anteriorMm.toFixed(1)} mm / 下方 ${k.dropMm.toFixed(1)} mm / 回転 ${(k.totalRotationRad * RAD).toFixed(1)}°`,
      ];
      lines.forEach((line, index) => { ctx.fillStyle = index === 3 ? "#ff87bf" : "#a9bdcb"; ctx.fillText(line, 1172, 746 + index * 27); });
      ctx.fillStyle = "#71899b"; ctx.font = "500 13px system-ui, sans-serif";
      ctx.fillText("教育・説明用の近似モデル。診断・治療計画の最終判断には使用しないでください。", 54, 944);
      ctx.fillText(new Date().toLocaleString("ja-JP"), 1520, 944);
      out.toBlob((blob) => {
        if (blob) downloadBlob(blob, `tmj-atlas-${dateStamp()}.png`);
      }, "image/png");
      setSaveStatus("PNGを保存しました。", true);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function dateStamp() {
    const date = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function safeReplaceState(url) {
    try {
      history.replaceState(null, "", url);
    } catch (error) {
      console.warn("URL状態の更新を省略しました。", error);
    }
  }

  function setSaveStatus(message, success) {
    dom.saveStatus.textContent = message;
    dom.saveStatus.style.color = success ? "#7be0ae" : "#ff8b83";
    toast(message, success ? "ok" : "error");
  }

  function toast(message, type = "ok") {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.style.borderColor = type === "error" ? "rgba(255,120,111,.48)" : "rgba(76,181,255,.35)";
    dom.toast.classList.add("show");
    toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 2400);
  }

  function cacheDom() {
    const ids = [
      "skullCanvas", "jointCanvas", "topCanvas", "timelineCanvas", "viewportGrid",
      "resetAllButton", "helpButton", "helpDialog", "centricButton", "animationSpeed",
      "timelinePlayButton", "timelineScrubber", "timelineTime", "fitViewButton", "focusJointButton",
      "toggleLabelsButton", "showAllLayersButton", "exportJsonButton", "importJsonButton", "copyShareButton",
      "captureButton", "jsonFileInput", "saveStatus", "toast", "linkedHeightReadout", "discRelationStatus",
      "metricCondyleForward", "metricCondyleDrop", "metricJawRotation", "metricMorphologyAngle",
      "metricSagittalLateralAngle", "metricDiscOffset", "metricClearance", "metricWorkingSide", "compatibilityLabel", "compatibilityBar",
      "compatibilityNote", "morphologyAngleBadge", "motionPhaseBadge", "viewSideLabel", "selectedSideChip",
      "topLeftAngle", "topRightAngle", "topIntercondylar", "skullZoomBadge", "jointModeBadge",
    ];
    for (const id of ids) dom[id] = document.getElementById(id);
  }

  async function init() {
    cacheDom();
    loadHashState();
    bindDataControls();
    bindNavigation();
    bindButtons();
    bindCanvasNavigation(dom.skullCanvas, view.skull);
    bindCanvasNavigation(dom.jointCanvas, view.joint);
    syncControls();
    scheduleRender();

    const observer = new ResizeObserver(scheduleRender);
    observer.observe(dom.skullCanvas.parentElement);
    observer.observe(dom.jointCanvas.parentElement);
    observer.observe(dom.topCanvas);
    observer.observe(dom.timelineCanvas);

    try {
      await loadAssets();
      scheduleRender();
    } catch (error) {
      console.error(error);
      toast("解剖画像の読み込みに失敗しました。配布一式の assets フォルダーを確認してください。", "error");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
