// 첫 설정 화면 문구. AI 이름은 쓰지 않는다(공통 화면은 어떤 AI인지 모른다).
// 사용 조건 전문은 TERMS_VERSION(shared/terms.ts)과 판을 맞춘다. 조건을 고치면 그 날짜도 올린다.
import type { Dict } from './types'

export const setup: Dict = {
  'setup.step': { ko: '{n}/{total}', en: '{n}/{total}' },
  'setup.step.label': { ko: '설정 단계', en: 'Setup step' },
  'setup.step.1.title': { ko: '비밀번호 정하기', en: 'Choose a password' },
  'setup.step.1.desc': { ko: 'Aether에 로그인할 때 씁니다.', en: 'You will use it to log in to Aether.' },
  'setup.step.2.title': { ko: '작업 환경 확인', en: 'Check your work environment' },
  'setup.step.2.desc': { ko: '대부분 기본값으로 충분합니다.', en: 'The defaults are fine for most people.' },
  'setup.step.3.title': { ko: '확인하고 시작하기', en: 'Review and get started' },
  'setup.step.3.desc': { ko: '시작하기 전에 꼭 알아야 할 내용입니다.', en: 'Please read this before you start.' },
  'setup.next': { ko: '다음', en: 'Next' },
  'setup.back': { ko: '뒤로', en: 'Back' },
  'setup.loading': { ko: '설정을 불러오는 중입니다.', en: 'Loading setup.' },
  'setup.loadFailed': { ko: '설정을 불러오지 못했습니다.', en: 'Could not load setup.' },
  'setup.retry': { ko: '다시 시도', en: 'Try again' },

  'setup.errorSummary': { ko: '입력을 확인해 주세요.', en: 'Please check your entries.' },
  'setup.errorSummaryOne': { ko: '입력을 한 가지 확인해 주세요.', en: 'Please check one entry.' },

  'setup.password.label': { ko: '비밀번호', en: 'Password' },
  'setup.password.hint': { ko: '8자 이상으로 정해 주세요.', en: 'Use at least 8 characters.' },
  'setup.password.confirm': { ko: '비밀번호 확인', en: 'Confirm password' },
  'setup.password.show': { ko: '비밀번호 보기', en: 'Show password' },
  'setup.password.hide': { ko: '비밀번호 숨기기', en: 'Hide password' },

  'setup.ai.title': { ko: '사용할 수 있는 AI', en: 'Available AI' },
  'setup.ai.help': {
    ko: '쓰려는 AI 프로그램을 따로 설치하고 로그인하세요. 지금 준비하지 않아도 시작할 수 있습니다.',
    en: 'Install and log in to the AI program you want to use. You can start without one.',
  },
  'setup.ai.checking': { ko: '확인하는 중', en: 'Checking' },
  'setup.ai.ready': { ko: '사용 가능', en: 'Ready' },
  'setup.ai.failed': { ko: '확인하지 못했습니다.', en: 'Could not check.' },
  'setup.ai.none': { ko: '확인할 AI가 없습니다.', en: 'No AI to check.' },
  'setup.ai.recheck': { ko: '다시 확인', en: 'Check again' },

  'setup.projectRoot.label': { ko: '작업 폴더', en: 'Work folder' },
  'setup.projectRoot.hint': {
    ko: '새 작업을 시작할 기본 폴더입니다.',
    en: 'The default folder for starting new work.',
  },

  'setup.advanced': { ko: '고급 설정', en: 'Advanced settings' },
  'setup.port.label': { ko: '포트', en: 'Port' },
  'setup.port.hint': { ko: '1024에서 65535 사이의 숫자입니다.', en: 'A number from 1024 to 65535.' },
  'setup.dataDir.label': { ko: '데이터 폴더', en: 'Data folder' },
  'setup.dataDir.hint': { ko: '대화 기록과 설정을 저장하는 폴더입니다.', en: 'Where conversations and settings are stored.' },

  'setup.browse': { ko: '찾아보기', en: 'Browse' },

  'setup.terms.title': { ko: '사용 조건', en: 'Terms of use' },
  'setup.consent.1': {
    ko: '연결한 AI는 작업 폴더 밖의 파일도 읽고 고칠 수 있고, 명령도 실행할 수 있습니다. 권한 확인을 끄면 묻지 않고 실행합니다.',
    en: 'A connected AI can read and edit files outside the work folder and run commands. If you turn off permission checks, it runs them without asking.',
  },
  'setup.consent.2': {
    ko: '대화 내용과 AI가 읽은 파일은 사용자가 고른 AI 서비스로 전송되며, 그 서비스의 약관이 적용됩니다.',
    en: 'Your conversations and the files the AI reads are sent to the AI service you choose, and that service’s terms apply.',
  },
  'setup.consent.3': {
    ko: 'Aether 개발자는 사용자 정보를 수집하지 않습니다. Aether가 만든 대화 기록과 설정은 이 컴퓨터에 저장됩니다. 다만 AI에게 보낸 대화와 파일은 사용자가 고른 AI 서비스의 약관을 따릅니다.',
    en: 'Aether’s developer does not collect your information. Conversation history and settings created by Aether are stored on this computer. However, conversations and files you send to an AI follow the terms of the AI service you choose.',
  },
  'setup.consent.4': {
    ko: 'AI가 만든 결과는 틀릴 수 있습니다. 중요한 데이터는 따로 백업하고, 결과는 직접 확인해 주세요.',
    en: 'AI output can be wrong. Back up important data separately and check the results yourself.',
  },
  'setup.consent.5': {
    ko: 'Aether는 무료로 제공되며 보증하지 않습니다. 사용 중 생긴 문제와 손해의 책임은 모두 사용자에게 있습니다.',
    en: 'Aether is free and comes with no warranty. You are solely responsible for any problem or damage arising from its use.',
  },
  'setup.terms.open': { ko: '전체 사용 조건 읽기', en: 'Read the full terms' },
  'setup.terms.noLink': { ko: '이 빌드에는 사용 조건 주소가 없습니다.', en: 'This build has no terms address.' },
  'setup.terms.agree': {
    ko: '사용 조건을 읽었고, 사용 책임이 저에게 있다는 데 동의합니다.',
    en: 'I have read the terms and agree that I am responsible for my use of Aether.',
  },

  'setup.terms.needCheck': { ko: '동의 체크박스를 먼저 선택해 주세요.', en: 'Select the agreement checkbox first.' },
  'setup.submit': { ko: '시작하기', en: 'Get started' },
  'setup.submitBusy': { ko: '저장하는 중', en: 'Saving' },

  'setup.error.tooShort': { ko: '비밀번호는 8자 이상이어야 합니다.', en: 'The password must be at least 8 characters.' },
  'setup.error.tooLong': { ko: '비밀번호가 너무 깁니다. 더 짧게 정해 주세요.', en: 'The password is too long. Please use a shorter one.' },
  'setup.error.mismatch': { ko: '두 비밀번호가 같지 않습니다.', en: 'The two passwords do not match.' },
  'setup.error.projectRootEmpty': { ko: '작업 폴더를 입력해 주세요.', en: 'Enter a work folder.' },
  'setup.error.projectRoot_invalid': { ko: '작업 폴더는 전체 경로여야 하며 Aether 프로그램 폴더 안에는 둘 수 없습니다.', en: 'Enter the full path of the work folder. It cannot be inside the Aether program folder.' },
  'setup.error.picker_failed': { ko: '폴더 선택 창을 열지 못했습니다. 경로를 직접 입력해 주세요.', en: 'Could not open the folder window. Type the path instead.' },
  'setup.error.project_root_missing': {
    ko: '이 폴더는 쓸 수 없습니다. 없는 폴더이거나 파일이거나, 보안을 위해 막아 둔 폴더(.ssh, AppData 등)입니다. 다른 폴더를 골라 주세요.',
    en: 'This folder cannot be used. It does not exist, it is a file, or it is a folder blocked for security (such as .ssh or AppData). Choose another folder.',
  },
  'setup.error.dataDirEmpty': { ko: '데이터 폴더를 입력해 주세요.', en: 'Enter a data folder.' },
  'setup.error.data_dir_invalid': { ko: '데이터 폴더는 전체 경로여야 하며 Aether 프로그램 폴더 안에는 둘 수 없습니다.', en: 'Enter the full path of the data folder. It cannot be inside the Aether program folder.' },
  'setup.error.data_dir_unwritable': { ko: '이 데이터 폴더에는 저장할 수 없습니다. 다른 폴더를 골라 주세요.', en: 'Cannot save to this data folder. Choose another folder.' },
  'setup.error.port_invalid': { ko: '포트는 1024에서 65535 사이의 숫자여야 합니다.', en: 'The port must be a number from 1024 to 65535.' },
  'setup.error.port_in_use': { ko: '이 포트는 이미 사용 중입니다. 다른 숫자를 입력해 주세요.', en: 'This port is already in use. Enter another number.' },
  'setup.error.terms_required': { ko: '계속하려면 사용 조건에 동의해야 합니다.', en: 'Agree to the terms of use to continue.' },
  'setup.error.already_saving': { ko: '이미 저장하고 있습니다. 잠시 기다려 주세요.', en: 'Already saving. Please wait a moment.' },
  'setup.error.save_failed': { ko: '저장하지 못했습니다. 다시 시도해 주세요.', en: 'Could not save. Please try again.' },

  'setup.wait.title': { ko: 'Aether를 켜는 중입니다', en: 'Starting Aether' },
  'setup.wait.body': { ko: '설정을 저장했습니다. 잠시 기다려 주세요.', en: 'Your settings are saved. Please wait a moment.' },
  'setup.wait.moved': {
    ko: '새 주소에서 Aether가 켜집니다. 잠시 뒤 아래 주소를 여세요.',
    en: 'Aether will start at the new address. Open the address below in a moment.',
  },
  'setup.wait.link': { ko: '새 주소 열기', en: 'Open the new address' },
  'setup.wait.slowTitle': { ko: '서버가 아직 켜지지 않았습니다', en: 'The server has not started yet' },
  'setup.wait.slowBody': {
    ko: '다시 확인해 보세요. 그래도 안 되면 컴퓨터를 다시 시작한 뒤 바탕화면 바로가기로 여세요.',
    en: 'Try checking again. If it still does not start, restart your computer and open Aether with the desktop shortcut.',
  },
  'setup.wait.check': { ko: '다시 확인', en: 'Check again' },
}
