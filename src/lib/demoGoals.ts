import type { GoalSeed } from './goalsApi'
import { DEFAULT_SURFACE_STYLE, ensureServerBucketStyle } from './surfaceStyles'
import { normalizeGoalColour, FALLBACK_GOAL_COLOR } from './goalsApi'

type DemoTask = {
  id: string
  text: string
  completed: boolean
  difficulty?: 'none' | 'green' | 'yellow' | 'red'
  priority?: boolean
}

type DemoBucket = {
  id: string
  name: string
  favorite: boolean
  archived: boolean
  surfaceStyle?: string
  tasks: DemoTask[]
}

type DemoGoal = {
  id: string
  name: string
  goalColour: string
  surfaceStyle?: string
  starred: boolean
  archived: boolean
  buckets: DemoBucket[]
}

export const DEMO_GOALS: DemoGoal[] = [
  {
    id: 'g_demo',
    name: 'MATH1131',
    goalColour: 'blue',
    surfaceStyle: 'glass',
    starred: false,
    archived: false,
    buckets: [
      {
        id: 'b_demo_1',
        name: 'Weekly Work (15%)',
        favorite: true,
        archived: false,
        surfaceStyle: 'cool-blue',
        tasks: [
          { id: 't_demo_1', text: 'Complete Week 3 quiz', completed: true, difficulty: 'green' },
          { id: 't_demo_2', text: 'Watch Module 2 lectures', completed: true, difficulty: 'green' },
          { id: 't_demo_3', text: 'Finish Maple TA (Week 4)', completed: false, difficulty: 'yellow' },
          { id: 't_demo_4', text: 'Submit weekly homework', completed: false, difficulty: 'green' },
        ],
      },
      { 
        id: 'b_demo_2',
        name: 'Assignment (10%)',
        favorite: true,
        archived: false,
        surfaceStyle: 'midnight',
        tasks: [
          { id: 't_demo_5', text: 'Read assignment brief', completed: true, difficulty: 'green' },
          { id: 't_demo_6', text: 'Start draft', completed: false, difficulty: 'yellow' },
          { id: 't_demo_7', text: 'Complete Q2-4', completed: false, difficulty: 'red' },
        ],
      },
      {
        id: 'b_demo_3',
        name: 'Lab Tests (25%)',
        favorite: false,
        archived: false,
        surfaceStyle: 'grove',
        tasks: [
          { id: 't_demo_8', text: 'Review Lab Test 1', completed: true, difficulty: 'green' },
          { id: 't_demo_9', text: 'Practice past papers', completed: false, difficulty: 'yellow' },
          { id: 't_demo_10', text: 'Revise differentiation', completed: false, difficulty: 'yellow' },
        ],
      },
      {
        id: 'b_demo_4',
        name: 'Final Exam (50%)',
        favorite: false,
        archived: false,
        surfaceStyle: 'soft-magenta',
        tasks: [
          { id: 't_demo_11', text: 'Create summary notes', completed: false, difficulty: 'yellow' },
          { id: 't_demo_12', text: 'Work through 2023 paper', completed: false, difficulty: 'red' },
          { id: 't_demo_13', text: 'Review series/sequences', completed: false, difficulty: 'yellow' },
        ],
      },
    ],
  },
  {
    id: 'g2',
    name: 'Land a Job/Internship',
    goalColour: 'magenta',
    surfaceStyle: 'glass',
    starred: false,
    archived: false,
    buckets: [
      {
        id: 'b4',
        name: 'Resume & Profile',
        favorite: true,
        archived: false,
        surfaceStyle: 'cherry',
        tasks: [
          { id: 't8', text: 'Update resume with recent experience', completed: true, difficulty: 'green' },
          { id: 't9', text: 'Refresh LinkedIn summary', completed: false, difficulty: 'yellow' },
          { id: 't19', text: 'Ask friend for feedback', completed: false, difficulty: 'green' },
        ],
      },
      {
        id: 'b5',
        name: 'Applications',
        favorite: true,
        archived: false,
        surfaceStyle: 'sunset-orange',
        tasks: [
          { id: 't10', text: 'Research 5 target companies', completed: true, difficulty: 'green' },
          { id: 't11', text: 'Submit 2 applications this week', completed: false, difficulty: 'yellow' },
          { id: 't20', text: 'Track deadlines in spreadsheet', completed: false, difficulty: 'green' },
        ],
      },
      {
        id: 'b6',
        name: 'Interview Prep',
        favorite: false,
        archived: false,
        surfaceStyle: 'warm-amber',
        tasks: [
          { id: 't12', text: 'Review common questions', completed: true, difficulty: 'green' },
          { id: 't13', text: 'Practice answers out loud', completed: false, difficulty: 'yellow' },
          { id: 't21', text: 'Research company values', completed: false, difficulty: 'green' },
        ],
      },
      {
        id: 'b7',
        name: 'Networking',
        favorite: false,
        archived: false,
        surfaceStyle: 'cool-blue',
        tasks: [
          { id: 't22', text: 'Message 1 person on LinkedIn', completed: false, difficulty: 'green' },
          { id: 't23', text: 'Attend upcoming careers event', completed: false, difficulty: 'yellow' },
          { id: 't24', text: 'Follow up after meeting', completed: false, difficulty: 'green' },
        ],
      },
    ],
  },
  {
    id: 'g3',
    name: 'Get in Shape',
    goalColour: 'green',
    surfaceStyle: 'glass',
    starred: false,
    archived: false,
    buckets: [
      {
        id: 'b8',
        name: 'Strength',
        favorite: true,
        archived: false,
        surfaceStyle: 'fresh-teal',
        tasks: [
          { id: 't25', text: 'Do 10 push-ups in a row', completed: true, difficulty: 'green' },
          { id: 't26', text: 'Do 5 pull-ups', completed: false, difficulty: 'yellow' },
          { id: 't27', text: 'Hold a 1-min plank', completed: false, difficulty: 'yellow' },
          { id: 't28', text: 'Complete 20 squats with good form', completed: false, difficulty: 'green' },
        ],
      },
      {
        id: 'b9',
        name: 'Cardio',
        favorite: true,
        archived: false,
        surfaceStyle: 'ember',
        tasks: [
          { id: 't29', text: 'Run 2km without stopping', completed: true, difficulty: 'green' },
          { id: 't30', text: 'Run 5km', completed: false, difficulty: 'yellow' },
          { id: 't31', text: 'Bike 10km', completed: false, difficulty: 'yellow' },
          { id: 't32', text: 'Swim 20 laps', completed: false, difficulty: 'red' },
        ],
      },
      {
        id: 'b10',
        name: 'Range of Motion',
        favorite: false,
        archived: false,
        surfaceStyle: 'linen',
        tasks: [
          { id: 't33', text: 'Touch toes', completed: true, difficulty: 'green' },
          { id: 't34', text: 'Do a full deep squat', completed: false, difficulty: 'yellow' },
          { id: 't35', text: 'Sit cross-legged comfortably', completed: false, difficulty: 'green' },
          { id: 't36', text: 'Hold a bridge pose', completed: false, difficulty: 'yellow' },
        ],
      },
    ],
  },
]

export const DEMO_GOAL_SEEDS: GoalSeed[] = DEMO_GOALS.map((goal) => ({
  name: goal.name,
  goalColour: normalizeGoalColour(goal.goalColour, FALLBACK_GOAL_COLOR),
  surfaceStyle: ensureServerBucketStyle(goal.surfaceStyle, DEFAULT_SURFACE_STYLE),
  starred: Boolean(goal.starred),
  archived: Boolean(goal.archived),
  buckets: goal.buckets.map((bucket) => ({
    name: bucket.name,
    favorite: bucket.favorite,
    archived: bucket.archived,
    surfaceStyle: ensureServerBucketStyle(bucket.surfaceStyle, DEFAULT_SURFACE_STYLE),
    tasks: bucket.tasks.map((task) => ({
      text: task.text,
      completed: task.completed,
      difficulty: task.difficulty ?? 'none',
      priority: task.priority ?? false,
    })),
  })),
}))
