import { useLocation, useOutlet } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useRef } from "react";

const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

const pageTransition = {
  type: "tween" as const,
  ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number],
  duration: 0.18,
};

export const AnimatedOutlet = () => {
  const location = useLocation();
  const outlet = useOutlet();
  // Freeze the outlet element so AnimatePresence can animate the exiting one
  const outletRef = useRef(outlet);
  if (outlet) outletRef.current = outlet;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        variants={pageVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={pageTransition}
        className="min-h-0"
      >
        {outlet ?? outletRef.current}
      </motion.div>
    </AnimatePresence>
  );
};
