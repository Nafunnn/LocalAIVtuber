import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
} from "@pixiv/three-vrm-animation";
import { VRM } from "@pixiv/three-vrm";
import { globalStateManager } from "@/lib/globalStateManager";
import { pipelineManager } from "@/lib/pipelineManager";
import { chatManager } from "@/lib/chatManager";
import {
  IDLE_ANIMATION,
  looksLikeBrowserRequest,
  pickAmbientGesture,
  pickGestureForMood,
  pickGestureFromText,
  pickGreetingGesture,
  pickSmartphoneGesture,
} from "@/lib/vrmAnimationCatalog";
import {
  detectFaceEmotion,
  vrmFacialController,
} from "@/lib/vrmFacialExpressions";

const DEFAULT_CHARACTER_MODEL_PATH = "/resource/VRM3D/models/春日部つむぎハイパー.vrm";

const AMBIENT_MIN_MS = 14000;
const AMBIENT_MAX_MS = 28000;
const SPEAK_GESTURE_CHANCE = 0.55;

interface VRM3dCanvasProps {
  modelPath?: string;
  isActive?: boolean;
}

enum AnimationType {
  Idle,
  Gesture,
}

type LoadAndPlayAnimationParams = {
  filename: string;
  animationType: AnimationType;
  fadeDuration?: number;
  override?: boolean;
  overridable?: boolean;
};

const VRM3dCanvas: React.FC<VRM3dCanvasProps> = ({ modelPath, isActive = true }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const gltfLoaderRef = useRef<GLTFLoader>(new GLTFLoader());
  const mainAnimationRef = useRef<THREE.AnimationAction | null>(null);
  const clockRef = useRef<THREE.Clock | null>(null);

  const speakAnimationRef = useRef<THREE.AnimationAction | null>(null);
  const blinkAnimationRef = useRef<THREE.AnimationAction | null>(null);

  const idleAnimationFileNameRef = useRef<string | null>(null);
  const lastPlayedGestureRef = useRef<THREE.AnimationAction | null>(null);
  const lastGestureFileRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const greetedRef = useRef(false);
  const lastAssistantLenRef = useRef(0);
  const wasSpeakingRef = useRef(false);
  const wasRecordingRef = useRef(false);
  const wasThinkingRef = useRef(false);
  const wasBrowserActiveRef = useRef(false);
  const lastBrowserUserKeyRef = useRef("");

  const [isSpeaking, setIsSpeaking] = React.useState(false);
  const canClickRef = useRef(true);

  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const companionModeCameraPositionRef = useRef(new THREE.Vector3(0, 1.7, 2.2));
  const companionModeCameraLookatRef = useRef(new THREE.Vector3(0, 1.2, 0));

  const loadAndPlayAnimation = async ({
    filename,
    animationType,
    fadeDuration = 0.5,
    override = false,
    overridable = false,
  }: LoadAndPlayAnimationParams) => {
    if (!override && lastPlayedGestureRef.current?.isRunning()) return;
    if (!mixerRef.current || !vrmRef.current) return;

    const fullPath = filename.startsWith("/api/character/files/")
      ? filename
      : `/api/character/files/VRM3D/animations/${filename}`;

    try {
      const gltfVrma = await gltfLoaderRef.current.loadAsync(fullPath);
      const vrmAnimation = gltfVrma.userData.vrmAnimations?.[0];
      if (!vrmAnimation) {
        console.warn("No VRM animation in", fullPath);
        return;
      }

      const clip = createVRMAnimationClip(vrmAnimation, vrmRef.current);
      const newAction = mixerRef.current.clipAction(clip);
      newAction.clampWhenFinished = true;
      lastGestureFileRef.current = fullPath;

      const onAnimationFinish = () => {
        mixerRef.current?.removeEventListener("finished", onAnimationFinish);
        if (idleAnimationFileNameRef.current) {
          void loadAndPlayAnimation({
            filename: idleAnimationFileNameRef.current,
            animationType: AnimationType.Idle,
          });
        }
      };

      if (animationType === AnimationType.Idle) {
        idleAnimationFileNameRef.current = fullPath;
        newAction.loop = THREE.LoopRepeat;
        lastPlayedGestureRef.current = null;
      } else {
        if (!overridable) lastPlayedGestureRef.current = newAction;
        newAction.loop = THREE.LoopOnce;
        mixerRef.current.addEventListener("finished", onAnimationFinish);
      }

      if (mainAnimationRef.current) {
        newAction.weight = 1;
        newAction.reset().play();
        mainAnimationRef.current.crossFadeTo(newAction, fadeDuration, true);
      } else {
        newAction.reset().play();
      }
      mainAnimationRef.current = newAction;
    } catch (err) {
      console.warn("Failed to play animation", fullPath, err);
    }
  };

  const playGesture = (file: string | null, opts?: { override?: boolean; overridable?: boolean }) => {
    if (!file || !readyRef.current) return;
    void loadAndPlayAnimation({
      filename: file,
      animationType: AnimationType.Gesture,
      override: opts?.override ?? false,
      overridable: opts?.overridable ?? false,
    });
  };

  const playSmartphone = (opts?: { override?: boolean }) => {
    playGesture(pickSmartphoneGesture(), { override: opts?.override ?? true, overridable: true });
    vrmFacialController.setEmotion("listen", 12000);
  };

  const latestUserText = () =>
    [...chatManager.getMessages()].reverse().find((m) => m.role === "user")?.content ?? "";

  useEffect(() => {
    if (isSpeaking) {
      speakAnimationRef.current?.reset().play();
    } else {
      speakAnimationRef.current?.stop();
    }
  }, [isSpeaking]);

  // Ambient + AI-driven gestures
  useEffect(() => {
    let ambientTimer: number | null = null;

    const scheduleAmbient = () => {
      if (ambientTimer) window.clearTimeout(ambientTimer);
      const delay = AMBIENT_MIN_MS + Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS);
      ambientTimer = window.setTimeout(() => {
        if (
          readyRef.current &&
          !lastPlayedGestureRef.current?.isRunning() &&
          globalStateManager.getState("ttsLiveVolume") <= 0.1 &&
          !globalStateManager.getState("isVoiceRecording") &&
          !globalStateManager.getState("isBrowserActive")
        ) {
          playGesture(pickAmbientGesture(lastGestureFileRef.current), { overridable: true });
        }
        scheduleAmbient();
      }, delay);
    };

    scheduleAmbient();

    const unsubVoice = globalStateManager.subscribe("isVoiceRecording", (recording) => {
      if (recording && !wasRecordingRef.current) {
        playGesture(pickGestureForMood("listen", lastGestureFileRef.current), { override: true });
        vrmFacialController.setEmotion("listen", 8000);
      } else if (!recording && wasRecordingRef.current) {
        vrmFacialController.setEmotion("neutral", 500);
      }
      wasRecordingRef.current = recording;
    });

    const unsubBrowser = globalStateManager.subscribe("isBrowserActive", (active) => {
      if (active && !wasBrowserActiveRef.current) {
        playSmartphone({ override: true });
      }
      wasBrowserActiveRef.current = active;
    });

    const unsubPipe = pipelineManager.subscribe((tasks) => {
      const active = tasks.find(
        (t) => t.status !== "task_finished" && t.status !== "cancelled"
      );
      const thinking = active?.status === "llm_started" || active?.status === "created";
      const userText = active?.input || latestUserText();
      const browserIntent = looksLikeBrowserRequest(userText);

      if (thinking && browserIntent) {
        playSmartphone({ override: true });
      } else if (thinking && !wasThinkingRef.current) {
        playGesture(pickGestureForMood("think", lastGestureFileRef.current), {
          override: false,
          overridable: true,
        });
        vrmFacialController.setEmotion("thinking", 10000);
      }
      wasThinkingRef.current = Boolean(thinking);
    });

    const applyFaceFromText = (text: string, userText = "") => {
      const emotion = detectFaceEmotion(text, userText);
      if (emotion !== "neutral") {
        vrmFacialController.setEmotion(emotion, 5000);
      }
    };

    const unsubChat = chatManager.subscribe((messages) => {
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = lastUser?.content ?? "";

      if (userText && looksLikeBrowserRequest(userText) && userText !== lastBrowserUserKeyRef.current) {
        lastBrowserUserKeyRef.current = userText;
        playSmartphone({ override: true });
      }

      if (!last?.content) return;
      const len = last.content.length;
      if (len < lastAssistantLenRef.current) {
        lastAssistantLenRef.current = len;
        return;
      }
      if (lastAssistantLenRef.current === 0 && len > 0) {
        if (!greetedRef.current) {
          greetedRef.current = true;
          playGesture(pickGreetingGesture(), { override: true });
          vrmFacialController.setEmotion("happy", 4000);
        } else if (looksLikeBrowserRequest(userText)) {
          playSmartphone({ override: false });
          applyFaceFromText(last.content, userText);
        } else {
          const keyed = pickGestureFromText(last.content) ?? pickGestureFromText(userText);
          playGesture(
            keyed ?? pickGestureForMood("speak", lastGestureFileRef.current),
            { override: false, overridable: true }
          );
          applyFaceFromText(last.content, userText);
        }
      } else if (len - lastAssistantLenRef.current > 24) {
        if (looksLikeBrowserRequest(userText) || looksLikeBrowserRequest(last.content)) {
          playSmartphone({ override: false });
        } else {
          const keyed = pickGestureFromText(last.content);
          if (keyed) playGesture(keyed, { overridable: true });
        }
        applyFaceFromText(last.content, userText);
      }
      lastAssistantLenRef.current = len;
    });

    const volumePoll = window.setInterval(() => {
      const speaking = globalStateManager.getState("ttsLiveVolume") > 0.1;
      if (speaking && !wasSpeakingRef.current) {
        const msgs = chatManager.getMessages();
        const assistantText =
          [...msgs].reverse().find((m) => m.role === "assistant")?.content ?? "";
        const userText = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
        applyFaceFromText(assistantText, userText);
        if (looksLikeBrowserRequest(userText) || looksLikeBrowserRequest(assistantText)) {
          playSmartphone({ override: false });
        } else if (Math.random() < SPEAK_GESTURE_CHANCE) {
          const keyed =
            pickGestureFromText(assistantText) ??
            pickGestureForMood("speak", lastGestureFileRef.current);
          playGesture(keyed, { overridable: true });
        }
      }
      wasSpeakingRef.current = speaking;
    }, 200);

    const browserPoll = window.setInterval(() => {
      void fetch("/api/mcp/browser/activity")
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as { active?: boolean; enabled?: boolean };
          globalStateManager.updateState("isBrowserActive", Boolean(data.enabled && data.active));
        })
        .catch(() => undefined);
    }, 1500);

    return () => {
      if (ambientTimer) window.clearTimeout(ambientTimer);
      window.clearInterval(volumePoll);
      window.clearInterval(browserPoll);
      unsubVoice();
      unsubBrowser();
      unsubPipe();
      unsubChat();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const scene = new THREE.Scene();
    const mountNode = mountRef.current;

    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(
      30,
      (mountNode?.clientWidth || window.innerWidth) / (mountNode?.clientHeight || window.innerHeight),
      0.1,
      1000
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    rendererRef.current = renderer;

    renderer.autoClear = false;
    renderer.setSize(mountNode?.clientWidth || window.innerWidth, mountNode?.clientHeight || window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    mountRef.current?.appendChild(renderer.domElement);
    camera.position.copy(companionModeCameraPositionRef.current);
    renderer.setClearColor(0x99ddff);
    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.target.copy(companionModeCameraLookatRef.current.clone());
    controls.update();

    const ambientLight = new THREE.AmbientLight(0xffffff, 2);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(0, 5, 3);
    scene.add(directionalLight);

    gltfLoaderRef.current.register((parser) => new VRMLoaderPlugin(parser));
    gltfLoaderRef.current.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const initVRMScene = async () => {
      const gltfVrm = await gltfLoaderRef.current.loadAsync(modelPath || DEFAULT_CHARACTER_MODEL_PATH);
      const vrm: VRM = gltfVrm.userData.vrm;
      vrmRef.current = vrm;
      VRMUtils.rotateVRM0(vrm);
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      vrm.scene.traverse((obj: THREE.Object3D) => {
        obj.frustumCulled = false;
      });
      if (!vrm.lookAt) return;
      const lookAtQuatProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      lookAtQuatProxy.name = "lookAtQuaternionProxy";
      vrm.scene.add(lookAtQuatProxy);
      const lookAtTarget = new THREE.Object3D();
      camera.add(lookAtTarget);
      vrm.lookAt.target = lookAtTarget;
      scene.add(vrm.scene);
      mixerRef.current = new THREE.AnimationMixer(vrm.scene);
      clockRef.current = new THREE.Clock();

      vrm.scene.position.set(0, 0, 0);
      vrm.springBoneManager?.reset();

      await loadAndPlayAnimation({
        filename: IDLE_ANIMATION,
        animationType: AnimationType.Idle,
        fadeDuration: 0,
        override: true,
      });
      vrmFacialController.attach(vrm);
      readyRef.current = true;

      if (!vrm.expressionManager) {
        console.error("vrm.expressionManager is null");
        return;
      }
      const speakExpressionTrackName = vrm.expressionManager.getExpressionTrackName("aa");
      if (!speakExpressionTrackName) {
        console.error("Expression track name for 'aa' is null");
        return;
      }
      const speakTrack = new THREE.NumberKeyframeTrack(
        speakExpressionTrackName,
        [0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.9],
        [0.0, 0.3, 0.0, 0.3, 0.1, 0.1, 0.3, 0.1, 0.1, 0.2]
      );
      let clip = new THREE.AnimationClip("Animation", 1.9, [speakTrack]);
      speakAnimationRef.current = mixerRef.current?.clipAction(clip);
      const blinkInterval = 2;
      const blinkExpressionTrackName = vrm.expressionManager.getExpressionTrackName("blink");
      if (!blinkExpressionTrackName) {
        console.error("Expression track name for 'blink' is null");
        return;
      }
      const blinkTrack = new THREE.NumberKeyframeTrack(
        blinkExpressionTrackName,
        [0.0, 0.05, 0.1, blinkInterval],
        [0.0, 1.0, 0.0, 0]
      );
      clip = new THREE.AnimationClip("Animation", 0.1 + blinkInterval, [blinkTrack]);
      blinkAnimationRef.current = mixerRef.current?.clipAction(clip);
      blinkAnimationRef.current?.play();

      const animate = () => {
        const deltaTime = clockRef.current?.getDelta();
        if (deltaTime) {
          mixerRef.current?.update(deltaTime);
          vrmFacialController.update(deltaTime);
          vrm.update(deltaTime);
        }

        setIsSpeaking(globalStateManager.getState("ttsLiveVolume") > 0.1);
        controls.update();
        renderer.render(scene, camera);
      };
      renderer.setAnimationLoop(animate);
    };

    const handleResize = () => {
      if (!mountNode) return;
      const width = mountNode.clientWidth || window.innerWidth;
      const height = mountNode.clientHeight || window.innerHeight;
      if (width === 0 || height === 0) return;

      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    handleResize();
    const resizeObserver = mountNode ? new ResizeObserver(handleResize) : null;
    resizeObserver?.observe(mountNode!);
    window.addEventListener("resize", handleResize);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const onMouseClick = (event: MouseEvent) => {
      const validElements = document.querySelectorAll("#character-canvas");
      const validElementsArray = Array.from(validElements);
      const targetElement = event.target as Element;
      if (targetElement && !validElementsArray.includes(targetElement)) return;

      if (!canClickRef.current || lastPlayedGestureRef.current?.isRunning()) return;

      const rect = (event.target as HTMLElement).getBoundingClientRect?.();
      if (rect) {
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      } else {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
      }

      raycaster.setFromCamera(mouse, camera);
      if (!vrmRef.current) return;
      const intersects = raycaster.intersectObject(vrmRef.current.scene, true);
      if (intersects.length > 0) {
        playGesture(pickAmbientGesture(lastGestureFileRef.current) ?? pickGreetingGesture(), {
          override: true,
        });
        vrmFacialController.setEmotion("happy", 2500);
      }
    };

    window.addEventListener("click", onMouseClick, false);

    void initVRMScene();
    return () => {
      readyRef.current = false;
      vrmFacialController.reset();
      vrmFacialController.attach(null);
      rendererRef.current = null;
      renderer.dispose();

      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      clockRef.current = null;

      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach((material) => material.dispose());
          } else {
            object.material.dispose();
          }
        }
      });

      controls.dispose();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("click", onMouseClick);

      if (mountNode && renderer.domElement) {
        mountNode.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isActive || !mountRef.current) return;

    const node = mountRef.current;
    const width = node.clientWidth;
    const height = node.clientHeight;
    if (width === 0 || height === 0) return;

    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    if (!camera || !renderer) return;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }, [isActive]);

  return <div id="character-canvas" ref={mountRef} className="w-full h-full" />;
};

export default VRM3dCanvas;
