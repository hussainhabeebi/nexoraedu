import React, { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { PageLoader } from './components/ui';
import PublicLayout from './components/PublicLayout';
import StaffLayout from './components/StaffLayout';
import StudentLayout from './components/StudentLayout';
import { Forbidden, NotFound } from './pages/Errors';

const L = <T extends React.ComponentType<any>>(f: () => Promise<{ default: T }>) => lazy(f);
// Public
const Home = L(() => import('./pages/public/Home'));
const Courses = L(() => import('./pages/public/Courses'));
const CourseDetail = L(() => import('./pages/public/CourseDetail'));
const Apply = L(() => import('./pages/public/Apply'));
const Track = L(() => import('./pages/public/Track'));
const Verify = L(() => import('./pages/public/Verify'));
const Contact = L(() => import('./pages/public/Contact'));
// Auth
const Login = L(() => import('./pages/auth/Login'));
const Forgot = L(() => import('./pages/auth/Forgot'));
const Reset = L(() => import('./pages/auth/Reset'));
const ChangePassword = L(() => import('./pages/auth/ChangePassword'));
// Staff
const Dashboard = L(() => import('./pages/staff/Dashboard'));
const Leads = L(() => import('./pages/staff/Leads'));
const LeadDetail = L(() => import('./pages/staff/LeadDetail'));
const FollowUps = L(() => import('./pages/staff/FollowUps'));
const Applications = L(() => import('./pages/staff/Applications'));
const ApplicationDetail = L(() => import('./pages/staff/ApplicationDetail'));
const Students = L(() => import('./pages/staff/Students'));
const StudentNew = L(() => import('./pages/staff/StudentNew'));
const StudentProfile = L(() => import('./pages/staff/StudentProfile'));
const Documents = L(() => import('./pages/staff/Documents'));
const Finance = L(() => import('./pages/staff/Finance'));
const Courses2 = L(() => import('./pages/staff/AcademicCourses'));
const Batches = L(() => import('./pages/staff/Batches'));
const BatchDetail = L(() => import('./pages/staff/BatchDetail'));
const Timetable = L(() => import('./pages/staff/Timetable'));
const Attendance = L(() => import('./pages/staff/Attendance'));
const Exams = L(() => import('./pages/staff/Exams'));
const ExamDetail = L(() => import('./pages/staff/ExamDetail'));
const QuestionBank = L(() => import('./pages/staff/QuestionBank'));
const Evaluation = L(() => import('./pages/staff/Evaluation'));
const Certificates = L(() => import('./pages/staff/Certificates'));
const Approvals = L(() => import('./pages/staff/Approvals'));
const WhatsApp = L(() => import('./pages/staff/WhatsApp'));
const Reports = L(() => import('./pages/staff/Reports'));
const Users = L(() => import('./pages/staff/Users'));
const Settings = L(() => import('./pages/staff/Settings'));
const Audit = L(() => import('./pages/staff/Audit'));
// Student
const SHome = L(() => import('./pages/student/Home'));
const STimetable = L(() => import('./pages/student/Timetable'));
const SFees = L(() => import('./pages/student/Fees'));
const SExams = L(() => import('./pages/student/Exams'));
const STakeExam = L(() => import('./pages/student/TakeExam'));
const SResults = L(() => import('./pages/student/Results'));
const SLearning = L(() => import('./pages/student/Learning'));
const SProfile = L(() => import('./pages/student/Profile'));

function RequireAuth({ children, student, perm, anyPortal }: { children: ReactNode; student?: boolean; perm?: string[]; anyPortal?: boolean }) {
  const { user, can } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to={student ? '/student/login' : '/login'} state={{ from: loc.pathname }} replace />;
  if (user.mustChangePassword && loc.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (anyPortal) return <>{children}</>;
  const isStudent = user.roles.includes('student') && user.roles.length === 1;
  if (student && !isStudent) return <Navigate to="/staff" replace />;
  if (!student && isStudent) return <Navigate to="/student" replace />;
  if (perm && !can(...perm)) return <Forbidden />;
  return <>{children}</>;
}

const P = (perm: string[], el: ReactNode) => <RequireAuth perm={perm}>{el}</RequireAuth>;

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<Home />} />
          <Route path="courses" element={<Courses />} />
          <Route path="courses/:slug" element={<CourseDetail />} />
          <Route path="apply" element={<Apply />} />
          <Route path="track" element={<Track />} />
          <Route path="verify" element={<Verify />} />
          <Route path="contact" element={<Contact />} />
        </Route>
        <Route path="login" element={<Login portal="staff" />} />
        <Route path="student/login" element={<Login portal="student" />} />
        <Route path="forgot-password" element={<Forgot />} />
        <Route path="reset-password" element={<Reset />} />
        <Route path="change-password" element={<RequireAuth anyPortal><ChangePassword /></RequireAuth>} />

        <Route path="staff" element={<RequireAuth><StaffLayout /></RequireAuth>}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="leads" element={P(['leads:read'], <Leads />)} />
          <Route path="leads/:id" element={P(['leads:read'], <LeadDetail />)} />
          <Route path="follow-ups" element={P(['leads:read'], <FollowUps />)} />
          <Route path="applications" element={P(['leads:read', 'students:read'], <Applications />)} />
          <Route path="applications/:id" element={P(['leads:read', 'students:read'], <ApplicationDetail />)} />
          <Route path="students" element={P(['students:read', 'students:read_batch'], <Students />)} />
          <Route path="students/new" element={P(['students:manage'], <StudentNew />)} />
          <Route path="students/:id" element={P(['students:read', 'students:read_batch'], <StudentProfile />)} />
          <Route path="documents" element={P(['documents:verify'], <Documents />)} />
          <Route path="finance/*" element={P(['finance:read'], <Finance />)} />
          <Route path="courses" element={P(['academics:read', 'masters:manage'], <Courses2 />)} />
          <Route path="batches" element={P(['academics:read'], <Batches />)} />
          <Route path="batches/:id" element={P(['academics:read', 'students:read'], <BatchDetail />)} />
          <Route path="timetable" element={P(['academics:read', 'attendance:mark'], <Timetable />)} />
          <Route path="attendance/:sessionId" element={P(['attendance:mark'], <Attendance />)} />
          <Route path="exams" element={P(['exams:read'], <Exams />)} />
          <Route path="exams/:id" element={P(['exams:read'], <ExamDetail />)} />
          <Route path="question-bank" element={P(['exams:read'], <QuestionBank />)} />
          <Route path="evaluation" element={P(['exams:manage'], <Evaluation />)} />
          <Route path="certificates" element={P(['exams:read'], <Certificates />)} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="approvals/:id" element={<Approvals />} />
          <Route path="whatsapp" element={P(['whatsapp:send'], <WhatsApp />)} />
          <Route path="reports" element={P(['reports:read'], <Reports />)} />
          <Route path="users" element={P(['users:read'], <Users />)} />
          <Route path="settings/*" element={P(['settings:manage', 'masters:manage', 'notifications:manage'], <Settings />)} />
          <Route path="audit" element={P(['audit:read'], <Audit />)} />
          <Route path="*" element={<NotFound />} />
        </Route>

        <Route path="student" element={<RequireAuth student><StudentLayout /></RequireAuth>}>
          <Route index element={<SHome />} />
          <Route path="timetable" element={<STimetable />} />
          <Route path="fees" element={<SFees />} />
          <Route path="exams" element={<SExams />} />
          <Route path="results" element={<SResults />} />
          <Route path="learning" element={<SLearning />} />
          <Route path="profile" element={<SProfile />} />
        </Route>
        <Route path="student/exam/:id" element={<RequireAuth student><STakeExam /></RequireAuth>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
