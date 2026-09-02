import { useEffect } from "react";
import { useSettings } from "@/context/SettingsContext";
import { cameraManager } from "@/lib/cameraManager";

const CAMERA_ENABLED_SETTING = "input.camera.enabled";
const CAMERA_DEVICE_SETTING = "input.camera.deviceId";

/**
 * Keeps webcam share alive app-wide when enabled in settings,
 * so chat/PTT can capture frames outside the Input page.
 */
export function CameraShareBootstrap() {
  const { settings, loading } = useSettings();

  useEffect(() => {
    if (loading) return;

    const enabled = Boolean(settings[CAMERA_ENABLED_SETTING]);
    const deviceId =
      typeof settings[CAMERA_DEVICE_SETTING] === "string"
        ? settings[CAMERA_DEVICE_SETTING]
        : "";

    void (async () => {
      await cameraManager.setDeviceId(deviceId);
      await cameraManager.setEnabled(enabled);
    })();
  }, [loading, settings[CAMERA_ENABLED_SETTING], settings[CAMERA_DEVICE_SETTING]]);

  useEffect(() => {
    return () => {
      // Do not stop on unmount of bootstrap alone — mainpage stays mounted.
    };
  }, []);

  return null;
}
