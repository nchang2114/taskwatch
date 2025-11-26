import type { GoalSeed } from './goalsApi'
import { DEFAULT_SURFACE_STYLE, ensureServerBucketStyle } from './surfaceStyles'

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
    name: 'Ace This Semester',
    goalColour: 'from-sky-500 to-indigo-500',
    surfaceStyle: 'glass',
    starred: false,
    archived: false,
    buckets: [
      {
        id: 'b_demo_1',
        name: 'Lectures & Notes',
        favorite: true,
        archived: false,
        surfaceStyle: 'cool-blue',
        tasks: [
          { id: 't_demo_1', text: 'Rewatch stats lecture clips', completed: false, difficulty: 'green' },
          { id: 't_demo_2', text: 'Tidy up Notion / flashcards', completed: false, difficulty: 'yellow' },
          { id: 't_demo_3', text: 'Summarize week 4 readings', completed: true, difficulty: 'green' },
        ],
      },
      {
        id: 'b_demo_2',
        name: 'Assignments',
        favorite: true,
        archived: false,
        surfaceStyle: 'midnight',
        tasks: [
          { id: 't_demo_4', text: 'Outline research essay intro', completed: false, difficulty: 'yellow' },
          { id: 't_demo_5', text: 'Submit lab to Canvas', completed: false, difficulty: 'green' },
          { id: 't_demo_6', text: 'Peer review teammate draft', completed: true, difficulty: 'green' },
        ],
      },
      {
        id: 'b_demo_3',
        name: 'Study Group',
        favorite: false,
        archived: false,
        surfaceStyle: 'grove',
        tasks: [
          { id: 't_demo_7', text: 'Schedule Thursday library block', completed: false, difficulty: 'yellow' },
          { id: 't_demo_8', text: 'Review problem set together', completed: false, difficulty: 'green' },
          { id: 't_demo_9', text: 'Office hours question list', completed: true, difficulty: 'none' },
        ],
      },
      {
        id: 'b_demo_4',
        name: 'Career Prep',
        favorite: false,
        archived: false,
        surfaceStyle: 'soft-magenta',
        tasks: [
          { id: 't_demo_10', text: 'Update resume bullet', completed: false, difficulty: 'yellow' },
          { id: 't_demo_11', text: 'Send LinkedIn coffee chat', completed: false, difficulty: 'green' },
        ],
      },
    ],
  },
  {
    id: 'g2',
    name: 'Level Up at Work',
    goalColour: 'from-emerald-500 to-cyan-500',
    surfaceStyle: 'glass',
    starred: false,
    archived: false,
    buckets: [
      {
        id: 'b4',
        name: 'Deep Work Sprints',
        favorite: true,
        archived: false,
        surfaceStyle: 'cherry',
        tasks: [
          { id: 't8', text: 'Draft QBR storyline', completed: false },
          { id: 't9', text: 'Polish slide templates', completed: false },
          { id: 't19', text: 'Block 2h no-meeting window', completed: false },
        ],
      },
      {
        id: 'b5',
        name: 'Team & Stakeholders',
        favorite: true,
        archived: false,
        surfaceStyle: 'sunset-orange',
        tasks: [
          { id: 't10', text: 'Prep talking points for stand-up', completed: false },
          { id: 't11', text: 'Ship weekly status update', completed: false },
          { id: 't20', text: 'Add wins to kudos doc', completed: false },
        ],
      },
      {
        id: 'b6',
        name: 'Career Growth',
        favorite: false,
        archived: false,
        surfaceStyle: 'warm-amber',
        tasks: [
          { id: 't12', text: 'Book mentor 1:1', completed: false },
          { id: 't13', text: 'Take LinkedIn Learning module', completed: false },
          { id: 't21', text: 'Update brag doc with metrics', completed: false },
        ],
      },
    ],
  },
  {
    id: 'g3',
    name: 'Healthy Work-Life Rhythm',
    goalColour: 'from-lime-400 to-emerald-500',
    surfaceStyle: 'glass',
    starred: false,
    archived: false,
    buckets: [
      {
        id: 'b7',
        name: 'Movement',
        favorite: true,
        archived: false,
        surfaceStyle: 'fresh-teal',
        tasks: [
          { id: 't14', text: 'Morning strength circuit', completed: false },
          { id: 't15', text: 'Midday stretch timer', completed: false },
          { id: 't22', text: 'Walk + call a friend', completed: false },
        ],
      },
      {
        id: 'b8',
        name: 'Meals & Fuel',
        favorite: true,
        archived: false,
        surfaceStyle: 'ember',
        tasks: [
          { id: 't16', text: 'Prep lunches for Mon–Wed', completed: false },
          { id: 't17', text: 'Grocery order for dinners', completed: false },
          { id: 't23', text: 'Cut fruit + overnight oats', completed: true },
        ],
      },
      {
        id: 'b9',
        name: 'Recharge',
        favorite: true,
        archived: false,
        surfaceStyle: 'linen',
        tasks: [
          { id: 't18', text: 'Lights out by 11:00p', completed: false },
          { id: 't24', text: 'Plan a no-screen morning', completed: false },
          { id: 't25', text: 'Sunday reset playlist + tidy', completed: true },
        ],
      },
    ],
  },
]

export const DEMO_GOAL_SEEDS: GoalSeed[] = DEMO_GOALS.map((goal) => ({
  name: goal.name,
  goalColour: goal.goalColour,
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
