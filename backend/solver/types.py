from dataclasses import dataclass
import numpy as np

@dataclass
class Track:
    x: np.ndarray
    y: np.ndarray
    curvature: np.ndarray
    density: np.ndarray
    #weather?

@dataclass
class Car:
    max_power: float
    max_speed: float
    max_accel: float
    max_brake: float
    mu: float #base grip coefficient
    downforce_coef: float
    drag_coef: float
    mass: float
    gravity: float = 9.81

@dataclass
class Solution:
    min_time: float
    heatmap: np.ndarray