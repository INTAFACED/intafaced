'use client';

import { useEffect, useState } from 'react';
import { animate, useMotionValue } from 'motion/react';
import * as motion from 'motion/react-client';
import { useReducedMotion } from 'motion/react';

import { cn } from '../lib/utils';

// Theme-aware color configurations
const themes = {
  dark: {
    bg: '#111113',
    containerBg: '#141416',
    underLayerBg: '#101012',
    borderFrom: '#0a0a0b',
    borderVia: '#1a1a1c',
    borderTo: '#252527',
    wellBg: '#0a0a0b',
    innerRingBg: '#0c0c0d',
    buttonBg: '#111113',
    textActive: 'text-white',
    textInactive: 'text-[#aab4ac] hover:text-white',
    iconColor: 'text-white hover:text-zinc-300',
  },
  light: {
    bg: '#f5f5f7',
    containerBg: '#ffffff',
    underLayerBg: '#e8e8ea',
    borderFrom: '#d0d0d5',
    borderVia: '#e5e5e8',
    borderTo: '#f0f0f2',
    wellBg: '#e0e0e3',
    innerRingBg: '#d8d8db',
    buttonBg: '#f0f0f2',
    textActive: 'text-zinc-900',
    textInactive: 'text-zinc-400 hover:text-zinc-600',
    iconColor: 'text-zinc-700 hover:text-zinc-900',
  },
};

interface ChoiceItem {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}
interface GradientButtonGroupProps {
  items: ChoiceItem[];
  value: string[];
  onValueChange: (value: string[]) => void;
  disabled?: boolean;
  label: string;
}

function InnerButtonOverlay({ isOverlayActive, isDarkMode }: { isOverlayActive: boolean; isDarkMode: boolean }) {
  const reduceMotion = useReducedMotion();
  const overlayProgress = useMotionValue(isOverlayActive ? 1 : 0);

  useEffect(() => {
    const controls = animate(overlayProgress, isOverlayActive ? 1 : 0, {
      delay: reduceMotion ? 0 : isOverlayActive ? 0.02 : 0,
      duration: reduceMotion ? 0 : isOverlayActive ? 0.18 : 0.14,
      ease: 'easeOut',
    });

    return () => controls.stop();
  }, [isOverlayActive, overlayProgress, reduceMotion]);

  return (
    <motion.span
      initial={false}
      className="absolute inset-0 rounded-[10px]"
      animate={
        isOverlayActive
          ? {
              borderWidth: 1,
              borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
            }
          : {
              borderWidth: 0,
              borderColor: 'transparent',
              boxShadow: 'none',
            }
      }
      transition={{
        borderColor: {
          duration: reduceMotion ? 0 : 0.16,
          ease: 'easeOut',
        },
      }}
      style={{
        borderStyle: 'solid',
      }}
    />
  );
}

export function GradientButtonGroup({ items: navItems, value, onValueChange, disabled = false, label }: GradientButtonGroupProps) {
  const reduceMotion = useReducedMotion();
  const [overlayReadyId, setOverlayReadyId] = useState<string | null>(null);
  const isDarkMode = true;
  const theme = themes.dark;
  return (
    <div className="flex w-full justify-center py-1">
      <div className="flex w-full min-w-0 items-center">
        <div className="relative flex w-full items-center">
          {/* Background tray layer (recessed) - spans full width including theme toggle */}
          <div
            className="absolute inset-0 z-0 rounded-[28px] transition-colors duration-300"
            style={{
              background: isDarkMode
                ? 'linear-gradient(180deg, #141416 0%, #111113 50%, #0e0e10 100%)'
                : 'linear-gradient(180deg, #d1d1d6 0%, #cacad0 50%, #c3c3c9 100%)',
              boxShadow: isDarkMode
                ? 'inset 0 2px 8px rgba(0,0,0,0.6), inset 0 1px 2px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.04)'
                : 'inset 0 2px 6px rgba(0,0,0,0.1), inset 0 0 0 1px rgba(0,0,0,0.08), 0 1px 0 rgba(255,255,255,0.55)',
            }}
          />

          {/* Foreground nav layer (raised) - sits on the left */}
          <div className="relative z-10 flex w-full">
            {/* Outer rim/bezel */}
            <div
              className="bg-muted dark:bg-background absolute -inset-[4px] rounded-[28px] border-[1px] transition-colors duration-300"
              style={{
                borderColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)',
              }}
            />

            {/* Inner container */}
            <div
              role="group"
              aria-label={label}
              className="relative flex w-full items-center gap-3 rounded-[24px] p-1.5 transition-colors duration-300"
              style={{
                background: isDarkMode
                  ? 'linear-gradient(180deg, #1c1c1f 0%, #17171a 52%, #131316 100%)'
                  : 'linear-gradient(180deg, #ffffff 0%, #fefeff 52%, #fcfcfe 100%)',
                borderTop: isDarkMode ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(255,255,255,1)',
                boxShadow: isDarkMode ? 'none' : '0 1px 2px rgba(0,0,0,0.04), 0 1px 0 rgba(255,255,255,1)',
              }}
            >
              {navItems.map((item) => {
                const isActive = value.includes(item.id);
                const isOverlayActive = isActive;

                const wellStyle = isDarkMode
                  ? {
                      background: 'linear-gradient(180deg, #0a0a0c 0%, #0e0e10 50%, #0c0c0e 100%)',
                      boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.9), inset 0 0 4px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.05)',
                    }
                  : {
                      boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.12), inset 0 0 4px rgba(0,0,0,0.06), 0 1px 0 rgba(255,255,255,0.9)',
                    };

                const innerGapStyle = isDarkMode
                  ? {
                      background: '#0a0a0d',
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.9), inset 0 0 2px rgba(0,0,0,0.6)',
                    }
                  : {
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.18), inset 0 0 2px rgba(0,0,0,0.1)',
                    };

                return (
                  <button
                    key={item.id}
                    type="button"
                    role="checkbox"
                    aria-checked={isActive}
                    disabled={disabled || item.disabled}
                    onClick={() => onValueChange(isActive ? value.filter((id) => id !== item.id) : [...value, item.id])}
                    className={cn(
                      'group/nav relative flex min-h-[76px] w-full items-center justify-center rounded-[18px] transition-all duration-300',
                      isActive ? theme.textActive : theme.textInactive,
                    )}
                    aria-label={item.label}
                  >
                    {/* Layered inset effect for active state - animated with layoutId */}
                    {isActive && (
                      <>
                        {/* Inset well/channel - creates the recessed groove */}
                        <motion.span
                          layoutId={`active-well-${item.id}`}
                          className="bg-muted absolute inset-0 rounded-[18px] transition-colors duration-300"
                          style={wellStyle}
                          transition={
                            reduceMotion
                              ? { duration: 0 }
                              : {
                                  type: 'spring',
                                  stiffness: 400,
                                  damping: 30,
                                }
                          }
                        />

                        {/* Gold ring container */}
                        <motion.span
                          layoutId={`active-gold-ring-${item.id}`}
                          className="absolute inset-[3px] overflow-hidden rounded-[15px]"
                          onLayoutAnimationComplete={() => setOverlayReadyId(item.id)}
                          transition={
                            reduceMotion
                              ? { duration: 0 }
                              : {
                                  type: 'spring',
                                  stiffness: 400,
                                  damping: 30,
                                }
                          }
                        >
                          {/* Spinning gradient ring */}
                          <span
                            className="absolute inset-[-60%] origin-center will-change-transform"
                            style={{
                              background: 'conic-gradient(from 220deg, #283325, #627f40, #b9f65a, #526443, #bccdd5, #283325)',
                            }}
                          />
                        </motion.span>

                        {/* Inner gap - thin dark channel between gold and button */}
                        <motion.span
                          layoutId={`active-inner-ring-${item.id}`}
                          className="bg-muted absolute inset-[6px] rounded-[12px] transition-colors duration-300"
                          style={innerGapStyle}
                          transition={
                            reduceMotion
                              ? { duration: 0 }
                              : {
                                  type: 'spring',
                                  stiffness: 400,
                                  damping: 30,
                                }
                          }
                        />
                      </>
                    )}

                    {/* Inner button background */}
                    <motion.span
                      initial={false}
                      className={cn(
                        'relative z-10 flex w-full items-center justify-center rounded-[10px]',
                        isActive ? 'min-h-[58px] w-[calc(100%-18px)]' : 'min-h-[76px] w-full',
                      )}
                      animate={
                        isActive
                          ? {
                              scale: 1,
                              opacity: 1,
                            }
                          : {
                              scale: 0.985,
                              opacity: 0.96,
                            }
                      }
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : {
                              type: 'spring',
                              stiffness: 380,
                              damping: 30,
                              delay: isActive ? 0.12 : 0,
                            }
                      }
                    >
                      <InnerButtonOverlay isOverlayActive={isOverlayActive} isDarkMode={isDarkMode} />
                      <span className="relative z-10 text-left text-base">
                        <span className="block font-medium">{item.label}</span>
                        {item.description && <span className="block text-sm text-muted-foreground">{item.description}</span>}
                      </span>
                    </motion.span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="h-0 lg:hidden" />
    </div>
  );
}
