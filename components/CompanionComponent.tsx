"use client";

import React, {useEffect, useRef, useState, useCallback} from 'react';
import {cn, configureAssistant, getSubjectColor} from "@/lib/utils";
import {vapi} from "@/lib/vapi.sdk";
import Image from "next/image";
import Lottie, {LottieRefCurrentProps} from "lottie-react";
import soundwaves from '@/constants/soundwaves.json'
import {addToSessionHistory} from "@/lib/actions/companion.actions";

enum CallStatus {
    INACTIVE = 'INACTIVE',
    CONNECTING = 'CONNECTING',
    ACTIVE = 'ACTIVE',
    FINISHED = 'FINISHED',
}

enum VoiceQuality {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high'
}

interface ConversationContext {
    subject: string;
    topic: string;
    previousMessages: SavedMessage[];
    userPreferences: {
        voiceQuality: VoiceQuality;
        noiseReduction: boolean;
        echoCancellation: boolean;
    };
}

const CompanionComponent = ({ companionId, subject, topic, name, userName, userImage, style, voice }: CompanionComponentProps) => {
    const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.INACTIVE);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [messages, setMessages] = useState<SavedMessage[]>([]);
    const [audioLevel, setAudioLevel] = useState(0);
    const [connectionQuality, setConnectionQuality] = useState('good');
    const [lastUserInput, setLastUserInput] = useState('');
    const [voiceActivityTimeout, setVoiceActivityTimeout] = useState<NodeJS.Timeout | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    const [conversationContext, setConversationContext] = useState<ConversationContext>({
        subject,
        topic,
        previousMessages: [],
        userPreferences: {
            voiceQuality: VoiceQuality.MEDIUM,
            noiseReduction: true,
            echoCancellation: true
        }
    });

    const lottieRef = useRef<LottieRefCurrentProps>(null);
    const transcriptRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom of transcript
    useEffect(() => {
        if (transcriptRef.current) {
            transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
        }
    }, [messages]);

    // Voice Activity Detection
    const resetVoiceActivityTimeout = useCallback(() => {
        if (voiceActivityTimeout) {
            clearTimeout(voiceActivityTimeout);
        }

        const timeout = setTimeout(() => {
            if (isListening && !isSpeaking) {
                setIsListening(false);
                console.log('Voice activity timeout - stopped listening');
            }
        }, 3000); // 3 seconds of silence

        setVoiceActivityTimeout(timeout);
    }, [isListening, isSpeaking, voiceActivityTimeout]);

    // Lottie animation control
    useEffect(() => {
        if (lottieRef.current) {
            if (isSpeaking) {
                lottieRef.current.play();
            } else {
                lottieRef.current.stop();
            }
        }
    }, [isSpeaking]);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyPress = (event: KeyboardEvent) => {
            if (event.key === ' ' && event.ctrlKey) {
                event.preventDefault();
                if (callStatus === CallStatus.ACTIVE) {
                    toggleMicrophone();
                }
            } else if (event.key === 'Escape') {
                if (callStatus === CallStatus.ACTIVE) {
                    handleDisconnect();
                }
            } else if (event.key === 'Enter' && event.ctrlKey) {
                event.preventDefault();
                if (callStatus === CallStatus.INACTIVE) {
                    handleCall();
                }
            }
        };

        window.addEventListener('keydown', handleKeyPress);
        return () => window.removeEventListener('keydown', handleKeyPress);
    }, [callStatus]);

    // Retry logic for failed connections
    const retryConnection = useCallback(async () => {
        if (retryCount < 3) {
            setRetryCount(prev => prev + 1);
            console.log(`Retrying connection... Attempt ${retryCount + 1}/3`);

            setTimeout(async () => {
                try {
                    await handleCall();
                } catch (error) {
                    console.error('Retry failed:', error);
                    if (retryCount >= 2) {
                        alert('Connection failed after 3 attempts. Please check your internet connection and try again.');
                        setCallStatus(CallStatus.INACTIVE);
                    }
                }
            }, 1000 * retryCount); // Exponential backoff
        }
    }, [retryCount]);

    useEffect(() => {
        const onCallStart = () => {
            setCallStatus(CallStatus.ACTIVE);
            setRetryCount(0);
            setConnectionQuality('good');
            console.log('Call started successfully');
        };

        const onCallEnd = () => {
            setCallStatus(CallStatus.FINISHED);
            setIsListening(false);
            setIsSpeaking(false);
            setAudioLevel(0);
            if (voiceActivityTimeout) {
                clearTimeout(voiceActivityTimeout);
            }
            addToSessionHistory(companionId);
            console.log('Call ended');
        };

        const onMessage = (message: Message) => {
            console.log('Message received:', message);

            if (message.type === 'transcript') {
                if (message.transcriptType === 'partial') {
                    setLastUserInput(message.transcript);
                    resetVoiceActivityTimeout();
                } else if (message.transcriptType === 'final') {
                    const newMessage = {
                        role: message.role,
                        content: message.transcript,
                        timestamp: new Date().toISOString()
                    };
                    setMessages((prev) => [newMessage, ...prev]);
                    setConversationContext(prev => ({
                        ...prev,
                        previousMessages: [newMessage, ...prev.previousMessages].slice(0, 10) // Keep last 10 messages for context
                    }));
                    setLastUserInput('');
                }
            }
        };

        const onSpeechStart = () => {
            setIsSpeaking(true);
            setIsListening(false);
            if (voiceActivityTimeout) {
                clearTimeout(voiceActivityTimeout);
            }
            console.log('AI started speaking');
        };

        const onSpeechEnd = () => {
            setIsSpeaking(false);
            console.log('AI finished speaking');
        };

        const onTranscriptStart = () => {
            setIsListening(true);
            resetVoiceActivityTimeout();
            console.log('Started listening to user');
        };

        const onTranscriptEnd = () => {
            setIsListening(false);
            console.log('Stopped listening to user');
        };

        const onVolumeLevel = (volume: number) => {
            setAudioLevel(volume);
        };

        const onConnectionQualityChange = (quality: string) => {
            setConnectionQuality(quality);
            console.log('Connection quality changed:', quality);
        };

        // Register all event listeners (REMOVED onError)
        try {
            vapi.on('call-start', onCallStart);
            vapi.on('call-end', onCallEnd);
            vapi.on('message', onMessage);
            vapi.on('speech-start', onSpeechStart);
            vapi.on('speech-end', onSpeechEnd);
            vapi.on('transcript-start', onTranscriptStart);
            vapi.on('transcript-end', onTranscriptEnd);
            vapi.on('volume-level', onVolumeLevel);
            vapi.on('connection-quality-change', onConnectionQualityChange);

            console.log('VAPI event listeners registered successfully');
        } catch (error) {
            console.error('Failed to register VAPI event listeners:', error);
        }

        return () => {
            try {
                vapi.off('call-start', onCallStart);
                vapi.off('call-end', onCallEnd);
                vapi.off('message', onMessage);
                vapi.off('speech-start', onSpeechStart);
                vapi.off('speech-end', onSpeechEnd);
                vapi.off('transcript-start', onTranscriptStart);
                vapi.off('transcript-end', onTranscriptEnd);
                vapi.off('volume-level', onVolumeLevel);
                vapi.off('connection-quality-change', onConnectionQualityChange);

                console.log('VAPI event listeners cleaned up successfully');
            } catch (error) {
                console.error('Failed to cleanup VAPI event listeners:', error);
            }
        };
    }, [companionId, retryConnection, resetVoiceActivityTimeout, voiceActivityTimeout]);

    const toggleMicrophone = () => {
        try {
            const currentMutedState = vapi.isMuted();
            vapi.setMuted(!currentMutedState);
            setIsMuted(!currentMutedState);
            console.log('Microphone toggled:', !currentMutedState);
        } catch (error) {
            console.error('Failed to toggle microphone:', error);
        }
    };

    const handleCall = async () => {
        try {
            setCallStatus(CallStatus.CONNECTING);
            console.log('Starting call with configuration:', { voice, style, subject, topic });

            // Simplified assistant configuration
            const assistantOverrides = {
                variableValues: {
                    subject,
                    topic,
                    style
                },
                clientMessages: ['transcript'],
                serverMessages: []
            };

            console.log('Calling vapi.start with:', assistantOverrides);
            await vapi.start(configureAssistant(voice, style), assistantOverrides);
            console.log('vapi.start completed successfully');
        } catch (error) {
            console.error('Failed to start call:', error);
            setCallStatus(CallStatus.INACTIVE);
            alert('Failed to start conversation. Please check your connection and try again.');
        }
    };

    const handleDisconnect = async () => {
        try {
            setCallStatus(CallStatus.FINISHED);
            await vapi.stop();
            console.log('Call disconnected successfully');
        } catch (error) {
            console.error('Failed to disconnect:', error);
        }
    };

    const updateVoiceQuality = (quality: VoiceQuality) => {
        setConversationContext(prev => ({
            ...prev,
            userPreferences: {
                ...prev.userPreferences,
                voiceQuality: quality
            }
        }));
    };

    return (
        <section className="flex flex-col h-[70vh]">
            {/* Voice Quality Settings - Now visible when INACTIVE or FINISHED */}
            {(callStatus === CallStatus.INACTIVE || callStatus === CallStatus.FINISHED) && (
                <div className="mb-4 p-3 bg-white border border-black rounded-4xl">
                    <h4 className="font-medium text-black mb-2">Voice Settings</h4>
                    <div className="flex gap-4 text-sm">
                        <label className="flex items-center gap-2 text-black">
                            <input
                                type="checkbox"
                                checked={conversationContext.userPreferences.noiseReduction}
                                onChange={(e) => setConversationContext(prev => ({
                                    ...prev,
                                    userPreferences: {
                                        ...prev.userPreferences,
                                        noiseReduction: e.target.checked
                                    }
                                }))}
                                className="accent-black border-black"
                                style={{ accentColor: '#000000' }}
                            />
                            Noise Reduction
                        </label>
                        <label className="flex items-center gap-2 text-black">
                            <input
                                type="checkbox"
                                checked={conversationContext.userPreferences.echoCancellation}
                                onChange={(e) => setConversationContext(prev => ({
                                    ...prev,
                                    userPreferences: {
                                        ...prev.userPreferences,
                                        echoCancellation: e.target.checked
                                    }
                                }))}
                                className="accent-black border-black"
                                style={{ accentColor: '#000000' }}
                            />
                            Echo Cancellation
                        </label>
                        <select
                            value={conversationContext.userPreferences.voiceQuality}
                            onChange={(e) => updateVoiceQuality(e.target.value as VoiceQuality)}
                            className="border border-black rounded-4xl px-2 py-1 text-black bg-white focus:outline-none focus:ring-2 focus:ring-black"
                            style={{
                                accentColor: '#000000',
                                color: '#000000'
                            }}
                        >
                            <option value={VoiceQuality.LOW} className="text-black bg-white">Low Quality</option>
                            <option value={VoiceQuality.MEDIUM} className="text-black bg-white">Medium Quality</option>
                            <option value={VoiceQuality.HIGH} className="text-black bg-white">High Quality</option>
                        </select>
                    </div>
                </div>
            )}

            <section className="flex gap-8 max-sm:flex-col">
                <div className="companion-section">
                    <div className="companion-avatar" style={{backgroundColor: getSubjectColor(subject)}}>
                        <div
                            className={cn('absolute transition-opacity duration-1000',
                                callStatus === CallStatus.FINISHED || callStatus === CallStatus.INACTIVE ? 'opacity-100' : 'opacity-0',
                                callStatus === CallStatus.CONNECTING && 'opacity-100 animate-pulse'
                            )}>
                            <Image src={`/icons/${subject}.svg`} alt={subject} width={150} height={150}
                                   className="max-sm:w-fit"/>
                        </div>

                        <div
                            className={cn('absolute transition-opacity duration-1000',
                                callStatus === CallStatus.ACTIVE ? 'opacity-100' : 'opacity-0'
                            )}>
                            <Lottie
                                lottieRef={lottieRef}
                                animationData={soundwaves}
                                autoplay={false}
                                className="companion-lottie"
                            />
                        </div>
                    </div>
                    <p className="font-bold text-2xl">{name}</p>
                </div>

                <div className="user-section">
                    <div className="user-avatar">
                        <Image src={userImage} alt={userName} width={130} height={130} className="rounded-lg"/>
                        <p className="font-bold text-2xl">{userName}</p>
                    </div>

                    {/* Connection Quality Indicator - Using your colors */}
                    {callStatus === CallStatus.ACTIVE && (
                        <div className="connection-status mb-2">
                            <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${
                                    connectionQuality === 'good' ? 'bg-green-500' :
                                        connectionQuality === 'fair' ? 'bg-yellow-500' : 'bg-red-500'
                                }`} />
                                <span className="text-xs text-black capitalize">
                                    {connectionQuality} connection
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Enhanced Audio Level Indicator - Using your colors */}
                    {callStatus === CallStatus.ACTIVE && (
                        <div className="audio-indicator mb-2">
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-4 rounded-full bg-black relative">
                                    <div
                                        className="w-full h-full rounded-full transition-all duration-100"
                                        style={{
                                            backgroundColor: isListening ? '#fccc41' : isSpeaking ? '#2c2c2c' : '#6b7280',
                                            transform: `scale(${isListening ? 1 + (audioLevel * 0.5) : 1})`,
                                            opacity: isListening || isSpeaking ? 1 : 0.3
                                        }}
                                    />
                                    {isListening && (
                                        <div className="absolute inset-0 rounded-full border-2 border-[#fccc41] animate-ping" />
                                    )}
                                </div>
                                <span className="text-sm text-black">
                                    {isListening ? 'Listening...' : isSpeaking ? 'AI Speaking' : 'Ready'}
                                </span>
                            </div>
                        </div>
                    )}

                    <button
                        className="btn-mic"
                        onClick={toggleMicrophone}
                        disabled={callStatus !== CallStatus.ACTIVE}
                        title="Toggle microphone (Ctrl + Space)"
                    >
                        <Image
                            src={isMuted ? '/icons/mix-off.svg' : '/icons/mic-on.svg'}
                            alt="mic"
                            width={36}
                            height={36}
                        />
                        <p className="max-sm:hidden">
                            {isMuted ? 'Turn on microphone' : 'Turn off microphone'}
                        </p>
                    </button>

                    <button
                        className={cn(
                            'rounded-lg py-2 cursor-pointer transition-colors w-full text-white',
                            callStatus === CallStatus.ACTIVE ? 'bg-red-700' : 'bg-primary',
                            callStatus === CallStatus.CONNECTING && 'animate-pulse'
                        )}
                        onClick={callStatus === CallStatus.ACTIVE ? handleDisconnect : handleCall}
                        disabled={callStatus === CallStatus.CONNECTING}
                        title={callStatus === CallStatus.ACTIVE ? "End session (Esc)" : "Start session (Ctrl + Enter)"}
                    >
                        {callStatus === CallStatus.ACTIVE
                            ? "End Session"
                            : callStatus === CallStatus.CONNECTING
                                ? `Connecting${retryCount > 0 ? ` (${retryCount}/3)` : ''}...`
                                : 'Start Session'
                        }
                    </button>

                    {/* Keyboard Shortcuts Help - Using your colors */}
                    {callStatus === CallStatus.INACTIVE && (
                        <div className="mt-2 text-xs text-black">
                            <p>Shortcuts: Ctrl+Enter to start, Ctrl+Space to mute, Esc to end</p>
                        </div>
                    )}
                </div>
            </section>

            {/* Enhanced Transcript Section - Using your colors */}
            <section className="flex-1 mt-6 border border-black rounded-4xl p-4 bg-white min-h-[200px]">
                <div className="flex justify-between items-center mb-3">
                    <h3 className="font-semibold text-lg text-black">Conversation Transcript</h3>
                    {messages.length > 0 && (
                        <button
                            onClick={() => setMessages([])}
                            className="text-xs text-black hover:text-gray-600"
                            title="Clear transcript"
                        >
                            Clear
                        </button>
                    )}
                </div>

                {/* Partial transcript indicator - Using your colors */}
                {lastUserInput && (
                    <div className="mb-2 p-2 bg-[#fccc41] border-l-4 border-black rounded">
                        <span className="text-sm text-black italic">Listening: {lastUserInput}</span>
                    </div>
                )}

                <div
                    ref={transcriptRef}
                    className="flex-1 overflow-y-auto max-h-[300px] space-y-2"
                    role="log"
                    aria-live="polite"
                    aria-label="Conversation transcript"
                >
                    {messages.length === 0 ? (
                        <p className="text-black text-center py-8">
                            No messages yet. Start a conversation to see the transcript here.
                        </p>
                    ) : (
                        messages.map((message, index) => {
                            const timestamp = new Date(message.timestamp).toLocaleTimeString();

                            if(message.role === 'assistant') {
                                return (
                                    <div key={index} className="flex gap-2 group">
                                        <span className="font-medium text-[#2c2c2c]">
                                            {name.split(' ')[0].replace(/[.,]/g, '')}:
                                        </span>
                                        <span className="text-black flex-1">{message.content}</span>
                                        <span className="text-xs text-black opacity-0 group-hover:opacity-100 transition-opacity">
                                            {timestamp}
                                        </span>
                                    </div>
                                )
                            } else {
                                return (
                                    <div key={index} className="flex gap-2 group">
                                        <span className="font-medium text-[#fccc41]">
                                            {userName}:
                                        </span>
                                        <span className="text-black flex-1">{message.content}</span>
                                        <span className="text-xs text-black opacity-0 group-hover:opacity-100 transition-opacity">
                                            {timestamp}
                                        </span>
                                    </div>
                                )
                            }
                        })
                    )}
                </div>
            </section>
        </section>
    )
}

export default CompanionComponent;