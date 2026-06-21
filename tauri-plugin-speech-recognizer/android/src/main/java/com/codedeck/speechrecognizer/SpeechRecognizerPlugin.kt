package com.codedeck.speechrecognizer

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import android.util.Log
import java.util.Locale

@InvokeArg
internal class StartListeningArgs {
    var language: String? = null
}

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")
    ]
)
class SpeechRecognizerPlugin(private val activity: Activity) : Plugin(activity) {

    private var speechRecognizer: SpeechRecognizer? = null
    private var isListening = false
    private var available = false

    companion object {
        // Must match the alias on the @TauriPlugin Permission annotation below.
        private const val MIC_ALIAS = "microphone"
    }

    override fun load(webView: WebView) {
        available = SpeechRecognizer.isRecognitionAvailable(activity)
        if (available) {
            activity.runOnUiThread {
                initRecognizer()
            }
        }
    }

    private fun initRecognizer() {
        speechRecognizer?.destroy()
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(activity).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    activity.runOnUiThread {
                        val event = JSObject()
                        event.put("state", "listening")
                        trigger("stateChange", event)
                    }
                }

                override fun onBeginningOfSpeech() {}

                override fun onRmsChanged(rmsdB: Float) {}

                override fun onBufferReceived(buffer: ByteArray?) {}

                override fun onEndOfSpeech() {
                    isListening = false
                    Log.d("SpeechPlugin", "onEndOfSpeech, isListening=$isListening")
                    activity.runOnUiThread {
                        val event = JSObject()
                        event.put("state", "processing")
                        trigger("stateChange", event)
                    }
                }

                override fun onError(error: Int) {
                    isListening = false
                    Log.d("SpeechPlugin", "onError: $error")
                    val errorMsg = when (error) {
                        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
                        SpeechRecognizer.ERROR_CLIENT -> "Client side error"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Insufficient permissions"
                        SpeechRecognizer.ERROR_NETWORK -> "Network error"
                        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
                        SpeechRecognizer.ERROR_NO_MATCH -> "No speech recognized"
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
                        SpeechRecognizer.ERROR_SERVER -> "Server error"
                        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech input"
                        else -> "Unknown error ($error)"
                    }
                    activity.runOnUiThread {
                        val event = JSObject()
                        event.put("error", errorMsg)
                        event.put("code", error)
                        trigger("error", event)

                        val stateEvent = JSObject()
                        stateEvent.put("state", "idle")
                        trigger("stateChange", stateEvent)
                    }
                }

                override fun onResults(results: Bundle?) {
                    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    isListening = false
                    Log.d("SpeechPlugin", "onResults: ${matches?.firstOrNull()?.take(50)}")
                    activity.runOnUiThread {
                        if (!matches.isNullOrEmpty()) {
                            val event = JSObject()
                            event.put("text", matches[0])
                            event.put("isFinal", true)
                            trigger("result", event)
                        }
                        val stateEvent = JSObject()
                        stateEvent.put("state", "idle")
                        trigger("stateChange", stateEvent)
                    }
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    if (!matches.isNullOrEmpty()) {
                        activity.runOnUiThread {
                            val event = JSObject()
                            event.put("text", matches[0])
                            event.put("isFinal", false)
                            trigger("result", event)
                        }
                    }
                }

                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
        }
    }

    @Command
    fun isAvailable(invoke: Invoke) {
        val ret = JSObject()
        ret.put("available", available)
        invoke.resolve(ret)
    }

    @Command
    fun requestPermission(invoke: Invoke) {
        // Already granted — resolve immediately.
        if (getPermissionState(MIC_ALIAS) == PermissionState.GRANTED) {
            val ret = JSObject()
            ret.put("granted", true)
            invoke.resolve(ret)
            return
        }

        // Hold the invoke open and let Tauri drive the OS dialog. The result is
        // delivered to micPermissionCallback once the user actually responds —
        // no fixed-delay polling from the frontend.
        requestPermissionForAlias(MIC_ALIAS, invoke, "micPermissionCallback")
    }

    @PermissionCallback
    fun micPermissionCallback(invoke: Invoke) {
        val granted = getPermissionState(MIC_ALIAS) == PermissionState.GRANTED
        val ret = JSObject()
        ret.put("granted", granted)
        invoke.resolve(ret)
    }

    @Command
    fun startListening(invoke: Invoke) {
        if (!available) {
            invoke.reject("Speech recognition is not available on this device")
            return
        }

        val hasPermission = ContextCompat.checkSelfPermission(
            activity,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasPermission) {
            invoke.reject("RECORD_AUDIO permission not granted. Call request_permission first.")
            return
        }

        // Re-create recognizer if it was destroyed
        if (speechRecognizer == null) {
            activity.runOnUiThread {
                initRecognizer()
            }
        }

        val args = invoke.parseArgs(StartListeningArgs::class.java)
        val locale = args.language ?: Locale.getDefault().toLanguageTag()

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }

        activity.runOnUiThread {
            try {
                speechRecognizer?.startListening(intent)
                isListening = true
                val ret = JSObject()
                ret.put("success", true)
                invoke.resolve(ret)
            } catch (e: Exception) {
                invoke.reject("Failed to start listening: ${e.message}")
            }
        }
    }

    @Command
    fun stopListening(invoke: Invoke) {
        Log.d("SpeechPlugin", "stopListening called, isListening=$isListening, recognizer=${speechRecognizer != null}")
        if (speechRecognizer != null) {
            activity.runOnUiThread {
                speechRecognizer?.stopListening()
                isListening = false
                val ret = JSObject()
                ret.put("success", true)
                invoke.resolve(ret)
            }
        } else {
            val ret = JSObject()
            ret.put("success", true)
            invoke.resolve(ret)
        }
    }

    override fun onDestroy() {
        activity.runOnUiThread {
            speechRecognizer?.destroy()
            speechRecognizer = null
        }
        super.onDestroy()
    }
}
