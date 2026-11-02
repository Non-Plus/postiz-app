import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import dayjs from 'dayjs';
import {
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { InstagramDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { DashboardFunction } from '@gitroom/nestjs-libraries/integrations/dashboard.function.decorator';

const instagramProvider = new InstagramProvider();

// Instagram API with Unified login: Meta apps created since October 2026 can
// no longer set up Instagram login, and their Facebook login accepts a
// configuration (config_id) instead of scopes. The token belongs to the
// client's business portfolio and reaches every Instagram account shared
// during the login, publishing runs on graph.facebook.com like the Facebook
// Business provider.
@Rules(
  "Instagram should have at least one attachment, if it's a story, it can have only one picture"
)
export class InstagramUnifiedProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'instagram-unified';
  name = 'Instagram\n(Unified login)';
  isBetweenSteps = true;
  toolTip =
    'Instagram must be a professional account, shared with your business portfolio when you log in';
  // granted by the configuration (INSTAGRAM_CONFIG_ID), not requested here
  scopes = [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights',
  ];
  override maxConcurrentJob = 400;
  editor = 'normal' as const;
  dto = InstagramDto;
  maxLength() {
    return 2200;
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    return instagramProvider.checkValidity(posts, settings);
  }

  public override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    return instagramProvider.handleErrors(body, status);
  }

  // the token of a configuration set to never expire can't be refreshed, a
  // revoked one needs a new login
  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  private redirectUri() {
    return `${
      process?.env.FRONTEND_URL?.indexOf('https') == -1
        ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
        : `${process?.env.FRONTEND_URL}`
    }/integrations/social/instagram-unified`;
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url:
        `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth` +
        `?client_id=${process.env.FACEBOOK_APP_ID}` +
        `&config_id=${process.env.INSTAGRAM_CONFIG_ID}` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri())}` +
        `&response_type=code` +
        `&override_default_response_type=true` +
        // always offer both the Instagram and the Facebook login
        `&prompt=login` +
        `&state=${state}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh: string;
  }) {
    const { access_token, error } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token` +
          `?client_id=${process.env.FACEBOOK_APP_ID}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&redirect_uri=${encodeURIComponent(this.redirectUri())}` +
          `&code=${params.code}`
      )
    ).json();

    if (!access_token) {
      console.log('Instagram unified login token exchange failed', error);
      return `Could not connect Instagram: ${error?.message || 'no token'}`;
    }

    // with this token /me is the business integration system user, the
    // Instagram account is picked in the next step
    const { id, name, error: meError } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me?fields=id,name&access_token=${access_token}`
      )
    ).json();

    if (!id) {
      console.log('Instagram unified login /me failed', meError);
      return `Could not connect Instagram: ${meError?.message || 'no user'}`;
    }

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      picture: '',
      username: '',
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    token: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const findAccount = (await this.pages(token)).find(
      (p) => p.id === requiredId
    );

    if (!findAccount) {
      throw new Error(
        'This Instagram account was not shared, please select it when you log in'
      );
    }

    const information = await this.fetchPageInformation(token, {
      id: requiredId,
      pageId: requiredId,
    });

    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  // The accounts shared during the login. Meta only lists them when the
  // Instagram account belongs to another business portfolio than the Meta app
  @DashboardFunction()
  async pages(token: string) {
    const accounts: any[] = [];
    let nextUrl:
      | string
      | undefined = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/assigned_instagram_accounts?fields=id,username&limit=100&access_token=${token}`;

    while (nextUrl) {
      const response: any = await (await fetch(nextUrl)).json();
      if (response.error) {
        throw new Error(
          `Could not list Instagram accounts: ${response.error.message}`
        );
      }
      accounts.push(...(response.data || []));
      nextUrl = response.paging?.next;
    }

    return Promise.all(
      accounts.map(async (account) => {
        const { name, username, profile_picture_url } = await (
          await fetch(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${account.id}?fields=name,username,profile_picture_url&access_token=${token}`
          )
        ).json();

        // no Facebook Page with Unified login, pageId only keeps the shape
        // the account picker expects
        return {
          pageId: account.id,
          id: account.id,
          name: name || username || account.username,
          username: username || account.username,
          picture: { data: { url: profile_picture_url || '' } },
        };
      })
    );
  }

  async fetchPageInformation(
    token: string,
    data: { pageId: string; id: string }
  ) {
    const { id, name, profile_picture_url, username } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${data.id}?fields=id,username,name,profile_picture_url&access_token=${token}`
      )
    ).json();

    return {
      id,
      name: name || username,
      picture: profile_picture_url || '',
      access_token: token,
      username,
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.post(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.facebook.com'
    );
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.postPending(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.facebook.com'
    );
  }

  // the graph domain travels inside pendingData, so these are pure delegations
  override async checkPostStatus(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.checkPostStatus(
      accessToken,
      pendingData,
      integration
    );
  }

  override async finalizePost(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.finalizePost(accessToken, pendingData, integration);
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.comment(
      id,
      postId,
      lastCommentId,
      accessToken,
      postDetails,
      integration,
      'graph.facebook.com'
    );
  }

  async analytics(id: string, accessToken: string, date: number) {
    return instagramProvider.analytics(
      id,
      accessToken,
      date,
      'graph.facebook.com'
    );
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ) {
    return instagramProvider.postAnalytics(
      integrationId,
      accessToken,
      postId,
      date,
      'graph.facebook.com'
    );
  }
}
